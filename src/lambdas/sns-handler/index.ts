import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  TimestreamWriteClient,
  WriteRecordsCommand,
} from "@aws-sdk/client-timestream-write";
const ssmClient = new SSMClient();
const timestreamClient = new TimestreamWriteClient();

/**
 * Simple Lambda function called from an SNS topic
 * Receives messages and outputs them to standard output
 */

export const handler = async (event: any, context: any) => {
  const { Octokit } = await import("@octokit/rest");

  // Processing SNS messages
  try {
    // Get messages from SNS events
    const records = event.Records || [];
    const secretToken = await getSecretFromParameterStore(
      "/github/metrics/github-token",
    );

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

        // Write pull request information to Timestream
        await sendPullRequestDataToTimestream(
          parsedMessage.organization,
          parsedMessage.repository,
          parsedMessage.number,
          pullRequest.changed_files,
          pullRequest.additions,
          pullRequest.deletions,
          parsedMessage.action,
          parsedMessage.deliveryId,
        );

        // Additional processing can be added here
        // In this simple example, we're just outputting the message
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
    { Name: "event_type", Value: "pull_request" },
  ];

  // Create a single record with multiple measure values
  const records = [
    {
      Dimensions: dimensions,
      MeasureName: "pr_stats",
      MeasureValueType: "MULTI",
      MeasureValues: [
        {
          Name: "pr_changed_files",
          Value: changedFiles.toString(),
          Type: "BIGINT",
        },
        { Name: "pr_additions", Value: additions.toString(), Type: "BIGINT" },
        { Name: "pr_deletions", Value: deletions.toString(), Type: "BIGINT" },
      ],
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
