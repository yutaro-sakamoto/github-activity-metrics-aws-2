import {
  TimestreamWriteClient,
  WriteRecordsCommand,
} from "@aws-sdk/client-timestream-write";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { Webhooks } from "@octokit/webhooks";
import ipRangeCheck from "ip-range-check";
import { getMeasure } from "./measures";

// Define GitHub IP ranges
const GITHUB_IP_RANGES = [
  "192.30.252.0/22",
  "185.199.108.0/22",
  "140.82.112.0/20",
  "143.55.64.0/20",
  "2a0a:a440::/29",
  "2606:50c0::/32",
];

// Initialize AWS SDK clients
const ssmClient = new SSMClient();
const timestreamClient = new TimestreamWriteClient();

// Function to retrieve secret from SSM Parameter Store
async function getSecretFromParameterStore(
  parameterName: string,
): Promise<string> {
  const params = {
    Name: parameterName,
    WithDecryption: true,
  };

  try {
    const command = new GetParameterCommand(params);
    const response = await ssmClient.send(command);
    return response.Parameter!.Value!;
  } catch (error) {
    console.error("Error fetching parameter from SSM:", error);
    throw error;
  }
}

// Function to send data to Timestream
async function sendToTimestream(
  data: any,
  databaseName: string,
  tableName: string,
) {
  // Get current timestamp in milliseconds
  const currentTime = Date.now().toString();

  // Create common dimensions (metadata)
  const commonDimensions = [
    { Name: "event_type", Value: data.event_type },
    { Name: "delivery_id", Value: data.delivery_id },
  ];

  // Add repository information if it exists
  if (data.repository) {
    commonDimensions.push(
      { Name: "repository_id", Value: data.repository.id.toString() },
      { Name: "repository_name", Value: data.repository.name },
      { Name: "repository_full_name", Value: data.repository.full_name },
    );
  }

  // Add organization information if it exists
  if (data.organization) {
    commonDimensions.push(
      { Name: "organization_id", Value: data.organization.id.toString() },
      { Name: "organization_login", Value: data.organization.login },
    );
  }

  // Add sender information if it exists
  if (data.sender) {
    commonDimensions.push(
      { Name: "sender_id", Value: data.sender.id.toString() },
      { Name: "sender_login", Value: data.sender.login },
    );
  }

  // Add action if it exists
  if (data.action) {
    commonDimensions.push({ Name: "action", Value: data.action });
  }

  const measure = getMeasure(data.event_type, data.payload);
  console.log("Measure:", measure);

  // Create records
  const records =
    "measureValue" in measure
      ? [
          {
            Dimensions: commonDimensions,
            MeasureName: measure.measureName,
            MeasureValue: measure.measureValue,
            MeasureValueType: measure.measureValueType,
            Time: currentTime,
          },
        ]
      : [
          {
            Dimensions: commonDimensions,
            MeasureName: measure.measureName,
            MeasureValues: measure.measureValues,
            MeasureValueType: measure.measureValueType,
            Time: currentTime,
          },
        ];

  try {
    const params = {
      DatabaseName: databaseName,
      TableName: tableName,
      Records: records,
    };

    const command = new WriteRecordsCommand(params);
    const result = await timestreamClient.send(command);
    return result;
  } catch (error) {
    console.error("Error sending data to Timestream:", error);
    throw error;
  }
}

// Main Lambda function handler
export const handler = async (event: any) => {
  console.log("Received webhook event");

  try {
    // Check source IP address
    const sourceIp =
      event.requestContext?.identity?.sourceIp ||
      event.requestContext?.http?.sourceIp;

    console.log(`Request from source IP: ${sourceIp}`);

    // Validate IP is from GitHub
    if (sourceIp) {
      const isGitHubIp = GITHUB_IP_RANGES.some((range) =>
        ipRangeCheck(sourceIp, range),
      );

      if (!isGitHubIp) {
        console.warn(`Blocked request from unauthorized IP: ${sourceIp}`);
        return {
          statusCode: 403,
          body: JSON.stringify({
            message: "Access denied: Source IP not allowed",
          }),
        };
      }

      console.log(`Confirmed request from authorized GitHub IP: ${sourceIp}`);
    } else {
      console.warn("Source IP could not be determined from the request");
    }

    // Get request body and headers
    let body = event.body;
    const headers = event.headers || {};
    const isBase64Encoded = event.isBase64Encoded || false;

    // If body is Base64 encoded, decode it
    if (isBase64Encoded && body) {
      body = Buffer.from(body, "base64").toString("utf8");
      console.log("Decoded Base64 body");
    }

    // Get GitHub event type and delivery ID
    const githubEvent = headers["X-GitHub-Event"] || headers["x-github-event"];
    const githubDelivery =
      headers["X-GitHub-Delivery"] || headers["x-github-delivery"];
    const signature =
      headers["X-Hub-Signature-256"] || headers["x-hub-signature-256"];

    // Check if request body exists
    if (!body) {
      console.error("No request body found");
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "No request body provided" }),
      };
    }

    // Get secret from SSM Parameter Store
    const secretToken = await getSecretFromParameterStore(
      "/github/metrics/secret-token",
    );

    // Create webhook instance with the secret
    const webhooks = new Webhooks({
      secret: secretToken,
    });

    // Ensure body is a string for webhook verification
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);

    // Verify GitHub webhook signature using @octokit/webhooks
    try {
      await webhooks.verify(bodyStr, signature);
    } catch (error) {
      console.error("Invalid signature", error);
      return {
        statusCode: 401,
        body: JSON.stringify({ message: "Invalid signature" }),
      };
    }

    // Parse request body
    let parsedBody;
    try {
      parsedBody = typeof body === "string" ? JSON.parse(body) : body;
    } catch (error) {
      console.error("Error parsing body:", error, "Raw body:", body);
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "Invalid JSON body",
          error: (error as Error).message,
        }),
      };
    }

    // Log metadata separately
    console.log("GitHub Webhook received:", {
      event_type: githubEvent,
      delivery_id: githubDelivery,
      repository: parsedBody.repository?.full_name,
      organization: parsedBody.organization?.login,
      sender: parsedBody.sender?.login,
    });

    // Create structured data
    const structuredData = {
      action: parsedBody.action,
      repository: parsedBody.repository
        ? {
            id: parsedBody.repository.id,
            name: parsedBody.repository.name,
            full_name: parsedBody.repository.full_name,
          }
        : null,
      organization: parsedBody.organization
        ? {
            login: parsedBody.organization.login,
            id: parsedBody.organization.id,
          }
        : null,
      sender: parsedBody.sender
        ? {
            login: parsedBody.sender.login,
            id: parsedBody.sender.id,
          }
        : null,
      event_type: githubEvent,
      delivery_id: githubDelivery,
      payload: parsedBody,
    };

    // Send structured data to Timestream
    await sendToTimestream(
      structuredData,
      process.env.TIMESTREAM_DATABASE_NAME!,
      process.env.TIMESTREAM_TABLE_NAME!,
    );

    // Return success response
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Webhook received and processed successfully",
        eventType: githubEvent,
      }),
    };
  } catch (error: any) {
    // Log error
    console.error("Error processing webhook:", error);

    // Return error response
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Error processing webhook",
        error: error.message,
      }),
    };
  }
};
