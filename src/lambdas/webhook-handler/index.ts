import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { Webhooks } from '@octokit/webhooks';
import ipRangeCheck from 'ip-range-check';
import { getMeasure } from './measures';

// Define GitHub IP ranges
const GITHUB_IP_RANGES = [
  '192.30.252.0/22',
  '185.199.108.0/22',
  '140.82.112.0/20',
  '143.55.64.0/20',
  '2a0a:a440::/29',
  '2606:50c0::/32',
];

// Initialize AWS SDK clients
const ssmClient = new SSMClient();
const s3Client = new S3Client();

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

// Function to send data to S3
async function sendToS3(
  data: any,
  bucketName: string,
) {
  // Get current timestamp
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hour = String(now.getUTCHours()).padStart(2, '0');
  const minute = String(now.getUTCMinutes()).padStart(2, '0');
  const timestamp = now.toISOString();

  // Create structured data record
  const structuredRecord = {
    timestamp,
    event_type: data.event_type,
    delivery_id: data.delivery_id,
    repository_id: data.repository?.id,
    repository_name: data.repository?.name,
    repository_full_name: data.repository?.full_name,
    organization_id: data.organization?.id,
    organization_login: data.organization?.login,
    sender_id: data.sender?.id,
    sender_login: data.sender?.login,
    action: data.action,
  };

  // Add event-specific measures
  const measure = getMeasure(data.event_type, data.payload);
  console.log('Measure:', measure);

  // Merge measure data into the record
  if ('measureValue' in measure) {
    structuredRecord[measure.measureName] = measure.measureValue;
  } else if ('measureValues' in measure) {
    // For multi-measure records, flatten the values
    measure.measureValues.forEach((mv: any) => {
      structuredRecord[mv.Name] = mv.Value;
    });
  }

  // Create S3 key with partitioning by date and hour
  // Format: event_type=<type>/year=<yyyy>/month=<mm>/day=<dd>/hour=<hh>/<timestamp>_<delivery_id>.json
  const key = `event_type=${data.event_type}/year=${year}/month=${month}/day=${day}/hour=${hour}/${timestamp}_${data.delivery_id}.json`;

  try {
    const params = {
      Bucket: bucketName,
      Key: key,
      Body: JSON.stringify(structuredRecord),
      ContentType: 'application/json',
    };

    const command = new PutObjectCommand(params);
    const result = await s3Client.send(command);
    console.log(`Successfully wrote to S3: ${key}`);
    return result;
  } catch (error) {
    console.error('Error sending data to S3:', error);
    throw error;
  }
}

async function publishPullRequestEventToSnsTopic(
  deriveryId: string,
  data: any,
) {
  if (
    'number' in data &&
    'action' in data &&
    'organization' in data &&
    'login' in data.organization &&
    'repository' in data &&
    'name' in data.repository
  ) {
    const snsClient = new SNSClient({ region: process.env.AWS_REGION });
    const snsTopicArn = process.env.SNS_TOPIC_ARN;
    const snsMessage = {
      deliveryId: deriveryId,
      eventType: 'pull_request',
      action: data.action,
      number: data.number,
      organization: data.organization.login,
      repository: data.repository.name,
    };
    await snsClient.send(
      new PublishCommand({
        Message: JSON.stringify(snsMessage),
        TopicArn: snsTopicArn,
      }),
    );
  }
}

// Main Lambda function handler
export const handler = async (event: any) => {
  console.log('Received webhook event');

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
            message: 'Access denied: Source IP not allowed',
          }),
        };
      }

      console.log(`Confirmed request from authorized GitHub IP: ${sourceIp}`);
    } else {
      console.warn('Source IP could not be determined from the request');
    }

    // Get request body and headers
    let body = event.body;
    const headers = event.headers || {};
    const isBase64Encoded = event.isBase64Encoded || false;

    // If body is Base64 encoded, decode it
    if (isBase64Encoded && body) {
      body = Buffer.from(body, 'base64').toString('utf8');
      console.log('Decoded Base64 body');
    }

    // Get GitHub event type and delivery ID
    const githubEvent = headers['X-GitHub-Event'] || headers['x-github-event'];
    const githubDelivery =
      headers['X-GitHub-Delivery'] || headers['x-github-delivery'];
    const signature =
      headers['X-Hub-Signature-256'] || headers['x-hub-signature-256'];

    // Check if request body exists
    if (!body) {
      console.error('No request body found');
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'No request body provided' }),
      };
    }

    // Get secret from SSM Parameter Store
    const secretToken = await getSecretFromParameterStore(
      '/github/metrics/secret-token',
    );

    // Create webhook instance with the secret
    const webhooks = new Webhooks({
      secret: secretToken,
    });

    // Ensure body is a string for webhook verification
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

    // Verify GitHub webhook signature using @octokit/webhooks
    try {
      await webhooks.verify(bodyStr, signature);
    } catch (error) {
      console.error('Invalid signature', error);
      return {
        statusCode: 401,
        body: JSON.stringify({ message: 'Invalid signature' }),
      };
    }

    // Parse request body
    let parsedBody;
    try {
      parsedBody = typeof body === 'string' ? JSON.parse(body) : body;
    } catch (error) {
      console.error('Error parsing body:', error, 'Raw body:', body);
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: 'Invalid JSON body',
          error: (error as Error).message,
        }),
      };
    }

    // Publish pull request event to SNS topic
    if (githubEvent === 'pull_request') {
      await publishPullRequestEventToSnsTopic(githubDelivery, parsedBody);
    }

    // Log metadata separately
    console.log('GitHub Webhook received:', {
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

    // Send structured data to S3
    await sendToS3(
      structuredData,
      process.env.RAW_DATA_BUCKET!,
    );

    // Return success response
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Webhook received and processed successfully',
        eventType: githubEvent,
      }),
    };
  } catch (error: any) {
    // Log error
    console.error('Error processing webhook:', error);

    // Return error response
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Error processing webhook',
        error: error.message,
      }),
    };
  }
};