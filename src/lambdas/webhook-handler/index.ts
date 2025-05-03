import {
  TimestreamWriteClient,
  WriteRecordsCommand,
} from "@aws-sdk/client-timestream-write";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { Webhooks } from "@octokit/webhooks";

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

function getMeasure(event_type: string, payload: any): any {
  switch (event_type) {
    case "push": {
      return {
        measureName: "push",
        measureValueType: "MULTI",
        measureValues: [
          {
            Name: "push_after",
            Type: "VARCHAR",
            Value: payload.after,
          },
          {
            Name: "push_ref",
            Type: "VARCHAR",
            Value: payload.ref,
          },
          {
            Name: "push_created",
            Type: "BOOLEAN",
            Value: String(payload.created),
          },
        ],
      };
    }
  }
  return {
    measureName: "dummyMeasure",
    measureValueType: "BIGINT",
    measureValue: 1,
  };
}

// Function to send data to Timestream
async function sendToTimestream(
  data: any,
  databaseName: string,
  tableName: string,
) {
  // 現在のタイムスタンプをミリ秒単位で取得
  const currentTime = Date.now().toString();

  // 共通ディメンション（メタデータ）を作成
  const commonDimensions = [
    { Name: "event_type", Value: data.event_type },
    { Name: "delivery_id", Value: data.delivery_id },
  ];

  // リポジトリ情報がある場合は追加
  if (data.repository) {
    commonDimensions.push(
      { Name: "repository_id", Value: data.repository.id.toString() },
      { Name: "repository_name", Value: data.repository.name },
      { Name: "repository_full_name", Value: data.repository.full_name },
    );
  }

  // 組織情報がある場合は追加
  if (data.organization) {
    commonDimensions.push(
      { Name: "organization_id", Value: data.organization.id.toString() },
      { Name: "organization_login", Value: data.organization.login },
    );
  }

  // 送信者情報がある場合は追加
  if (data.sender) {
    commonDimensions.push(
      { Name: "sender_id", Value: data.sender.id.toString() },
      { Name: "sender_login", Value: data.sender.login },
    );
  }

  // actionが存在する場合は追加
  if (data.action) {
    commonDimensions.push({ Name: "action", Value: data.action });
  }

  const measure = getMeasure(data.event_type, data.payload);

  // レコードを作成
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

    // メタデータを別途ロギングする
    console.log("GitHub Webhook received:", {
      event_type: githubEvent,
      delivery_id: githubDelivery,
      repository: parsedBody.repository?.full_name,
      organization: parsedBody.organization?.login,
      sender: parsedBody.sender?.login,
    });

    // 構造化されたデータを作成
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

    // 構造化されたデータをTimestreamに送信
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
