import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
const ssmClient = new SSMClient();
const s3Client = new S3Client();

/**
 * Simple Lambda function called from an SNS topic
 * Receives messages and outputs them to standard output
 */

export const handler = async (event: any, context: any) => {
  const { Octokit } = await import('@octokit/rest');

  // Processing SNS messages
  try {
    // Get messages from SNS events
    const records = event.Records || [];
    const secretToken = await getSecretFromParameterStore(
      '/github/metrics/github-token',
    );

    for (const record of records) {
      if (record.Sns) {
        const message = record.Sns.Message;
        console.log('SNS message:', message);

        const parsedMessage = JSON.parse(message);

        const octokit = new Octokit({
          auth: secretToken,
        });

        const { data: pullRequest } = await octokit.pulls.get({
          owner: parsedMessage.organization,
          repo: parsedMessage.repository,
          pull_number: parsedMessage.number,
        });

        // Write pull request information to S3
        await sendPullRequestDataToS3(
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
      body: JSON.stringify({ message: 'success' }),
    };
  } catch (error) {
    console.error('Unknown error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Unknown error',
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
    console.error('Error fetching parameter from SSM:', error);
    throw error;
  }
}

// Function to send PR data to S3
async function sendPullRequestDataToS3(
  organization: string,
  repository: string,
  pullNumber: number,
  changedFiles: number,
  additions: number,
  deletions: number,
  action: string,
  deliveryId: string,
) {
  // Get current timestamp
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hour = String(now.getUTCHours()).padStart(2, '0');
  const timestamp = now.toISOString();

  // Create structured record for S3
  const structuredRecord = {
    timestamp,
    event_type: 'pull_request_api_result',
    organization,
    repository,
    pull_number: pullNumber,
    action,
    delivery_id: deliveryId,
    pr_changed_files: changedFiles,
    pr_additions: additions,
    pr_deletions: deletions,
  };

  // Create S3 key with partitioning
  // Format: github_api_result/year=<yyyy>/month=<mm>/day=<dd>/hour=<hh>/<timestamp>_<delivery_id>.json
  const key = `github_api_result/year=${year}/month=${month}/day=${day}/hour=${hour}/${timestamp}_${deliveryId}.json`;

  try {
    const params = {
      Bucket: process.env.RAW_DATA_BUCKET!,
      Key: key,
      Body: JSON.stringify(structuredRecord),
      ContentType: 'application/json',
    };

    const command = new PutObjectCommand(params);
    const result = await s3Client.send(command);
    console.log('Successfully wrote PR data to S3:', result);
    console.log(`Successfully wrote to S3: ${key}`);
    return result;
  } catch (error) {
    console.error('Error sending PR data to S3:', error);
    throw error;
  }
}