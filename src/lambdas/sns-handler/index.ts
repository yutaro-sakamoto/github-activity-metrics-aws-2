import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  TimestreamWriteClient,
  WriteRecordsCommand,
} from "@aws-sdk/client-timestream-write";
//import { Octokit } from "@octokit/rest";
const ssmClient = new SSMClient();
const timestreamClient = new TimestreamWriteClient();

/**
 * SNS トピックから呼び出されるシンプルなLambda関数
 * メッセージを受信して標準出力に出力します
 */

export const handler = async (event: any, context: any) => {
  console.log("event:", JSON.stringify(event));
  console.log("context:", JSON.stringify(context));
  const { Octokit } = await import("@octokit/rest");

  // SNSメッセージの処理
  try {
    // SNSイベントからメッセージを取得
    const records = event.Records || [];
    const secretToken = await getSecretFromParameterStore(
      "/github/metrics/github-token",
    );

    console.log("Length of secretToken:", secretToken.length);
    for (const record of records) {
      if (record.Sns) {
        const message = record.Sns.Message;
        console.log("SNS message:", message);

        const parsedMessage = JSON.parse(message);

        const octokit = new Octokit({
          auth: secretToken,
        });

        const { data: pullRequest } = await octokit.pulls.get({
          owner: parsedMessage.organization,
          repo: parsedMessage.repository,
          pull_number: parsedMessage.number,
        });

        console.log("changed_files:", pullRequest.changed_files);
        console.log("additions:", pullRequest.additions);
        console.log("deletions:", pullRequest.deletions);

        // プルリクエストの情報をTimestreamに書き込む
        await sendPullRequestDataToTimestream(
          parsedMessage.organization,
          parsedMessage.repository,
          parsedMessage.number,
          pullRequest.changed_files,
          pullRequest.additions,
          pullRequest.deletions,
          parsedMessage.action,
          parsedMessage.delivery_id,
        );

        // ここで必要な処理を追加できます
        // このシンプルな例では、メッセージを出力するだけです
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "success" }),
    };
  } catch (error) {
    console.error("Unknown error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Unknown error",
      }),
    };
  }
};

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

// Function to send PR data to Timestream
async function sendPullRequestDataToTimestream(
  organization: string,
  repository: string,
  pullNumber: number,
  changedFiles: number,
  additions: number,
  deletions: number,
  action: string,
  deliveryId: string,
) {
  // Get current timestamp in milliseconds
  const currentTime = Date.now().toString();

  // Create dimensions (metadata) for the record
  const dimensions = [
    { Name: "organization", Value: organization },
    { Name: "repository", Value: repository },
    { Name: "pull_number", Value: pullNumber.toString() },
    { Name: "action", Value: action },
    { Name: "delivery_id", Value: deliveryId },
    { Name: "event_type", Value: "pull_request_details" },
  ];

  // Create records for each metric we want to store
  const records = [
    {
      Dimensions: dimensions,
      MeasureName: "changed_files",
      MeasureValue: changedFiles.toString(),
      MeasureValueType: "BIGINT" as const,
      Time: currentTime,
    },
    {
      Dimensions: dimensions,
      MeasureName: "additions",
      MeasureValue: additions.toString(),
      MeasureValueType: "BIGINT" as const,
      Time: currentTime,
    },
    {
      Dimensions: dimensions,
      MeasureName: "deletions",
      MeasureValue: deletions.toString(),
      MeasureValueType: "BIGINT" as const,
      Time: currentTime,
    },
  ];

  try {
    const params = {
      DatabaseName: process.env.TIMESTREAM_DATABASE_NAME!,
      TableName: process.env.TIMESTREAM_TABLE_NAME!,
      Records: records,
    };

    const command = new WriteRecordsCommand(params);
    const result = await timestreamClient.send(command);
    console.log("Successfully wrote PR data to Timestream:", result);
    return result;
  } catch (error) {
    console.error("Error sending PR data to Timestream:", error);
    throw error;
  }
}
