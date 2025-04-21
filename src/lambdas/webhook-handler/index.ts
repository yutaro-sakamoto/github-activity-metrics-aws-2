import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { FirehoseClient, PutRecordCommand } from "@aws-sdk/client-firehose";
import * as crypto from "crypto";

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

// Function to verify GitHub signature
function verifySignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  try {
    // Check if X-Hub-Signature-256 exists
    if (!signature || !signature.startsWith("sha256=")) {
      return false;
    }

    // Parse signature
    const signatureHash = signature.substring(7); // Remove 'sha256='

    // Calculate expected signature
    const hmac = crypto.createHmac("sha256", secret);
    const calculatedSignature = hmac.update(payload).digest("hex");

    // Compare using timing-safe comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(signatureHash, "hex"),
      Buffer.from(calculatedSignature, "hex"),
    );
  } catch (error) {
    console.error("Signature verification error:", error);
    return false;
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
    const body = event.body;
    const headers = event.headers || {};

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

    // Verify GitHub webhook signature
    const isValid = verifySignature(
      typeof body === "string" ? body : JSON.stringify(body),
      signature,
      secretToken,
    );

    if (!isValid) {
      console.error("Invalid signature");
      return {
        statusCode: 401,
        body: JSON.stringify({ message: "Invalid signature" }),
      };
    }

    // Parse request body (if necessary)
    const parsedBody = typeof body === "string" ? JSON.parse(body) : body;

    // Prepare data to send to Firehose
    const data = {
      event_type: githubEvent,
      delivery_id: githubDelivery,
      repository: parsedBody.repository?.full_name,
      organization: parsedBody.organization?.login,
      sender: parsedBody.sender?.login,
      timestamp: new Date().toISOString(),
      payload: parsedBody,
    };

    // Send data to Firehose
    const result = await sendToFirehose(
      data,
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
