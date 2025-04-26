import { FirehoseClient, PutRecordCommand } from "@aws-sdk/client-firehose";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { Webhooks } from "@octokit/webhooks";

// Initialize AWS SDK clients
const ssmClient = new SSMClient();
const firehoseClient = new FirehoseClient();

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

// Function to send data to Firehose
async function sendToFirehose(data: any, deliveryStreamName: string) {
  const params = {
    DeliveryStreamName: deliveryStreamName,
    Record: {
      Data: Buffer.from(JSON.stringify(data)),
    },
  };

  try {
    const command = new PutRecordCommand(params);
    const result = await firehoseClient.send(command);
    return result;
  } catch (error) {
    console.error("Error sending data to Firehose:", error);
    throw error;
  }
}

// Main Lambda function handler
export const handler = async (event: any) => {
  console.log("Received webhook event");

  try {
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

    // メタデータを別途ロギングするが、Firehoseにはオリジナルデータをそのまま送信
    console.log("GitHub Webhook received:", {
      event_type: githubEvent,
      delivery_id: githubDelivery,
      repository: parsedBody.repository?.full_name,
      organization: parsedBody.organization?.login,
      sender: parsedBody.sender?.login,
    });

    // 構造化されたデータをFirehoseに送信
    // Athenaクエリでアクセスしやすいように重要なフィールドは最上位に配置し、
    // 元のJSONデータ全体をpayloadフィールドに含める
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
      // webhookデータ全体をJSON文字列としてpayloadフィールドに格納
      payload: JSON.stringify(parsedBody),
    };

    // 構造化されたデータをFirehoseに送信
    const result = await sendToFirehose(
      structuredData,
      process.env.DELIVERY_STREAM_NAME!,
    );

    // Return success response
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Webhook received and processed successfully",
        recordId: result.RecordId,
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
