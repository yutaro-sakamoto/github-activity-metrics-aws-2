import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { FirehoseClient, PutRecordCommand } from "@aws-sdk/client-firehose";
import * as crypto from "crypto";

// AWS SDKクライアントの初期化
const ssmClient = new SSMClient();
const firehoseClient = new FirehoseClient();

// SSMパラメータストアからシークレットを取得する関数
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

// GitHubのシグネチャを検証する関数
function verifySignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  try {
    // X-Hub-Signature-256があるか確認
    if (!signature || !signature.startsWith("sha256=")) {
      return false;
    }

    // シグネチャをパース
    const signatureHash = signature.substring(7); // 'sha256=' を除去

    // 期待されるシグネチャを計算
    const hmac = crypto.createHmac("sha256", secret);
    const calculatedSignature = hmac.update(payload).digest("hex");

    // タイミング攻撃を防ぐための比較
    return crypto.timingSafeEqual(
      Buffer.from(signatureHash, "hex"),
      Buffer.from(calculatedSignature, "hex"),
    );
  } catch (error) {
    console.error("Signature verification error:", error);
    return false;
  }
}

// Firehoseにデータを送信する関数
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

// Lambda関数のメインハンドラー
export const handler = async (event: any) => {
  console.log("Received webhook event");

  try {
    // リクエストボディとヘッダーの取得
    const body = event.body;
    const headers = event.headers || {};

    // GitHubのイベントタイプとdelivery IDを取得
    const githubEvent = headers["X-GitHub-Event"] || headers["x-github-event"];
    const githubDelivery =
      headers["X-GitHub-Delivery"] || headers["x-github-delivery"];
    const signature =
      headers["X-Hub-Signature-256"] || headers["x-hub-signature-256"];

    // リクエストボディが存在するかチェック
    if (!body) {
      console.error("No request body found");
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "No request body provided" }),
      };
    }

    // SSMパラメータストアからシークレットを取得
    const secretToken = await getSecretFromParameterStore(
      "/github/metrics/secret-token",
    );

    // GitHub webhookシグネチャを検証
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

    // リクエストボディをパース（必要に応じて）
    const parsedBody = typeof body === "string" ? JSON.parse(body) : body;

    // Firehoseに送信するデータを準備
    const data = {
      event_type: githubEvent,
      delivery_id: githubDelivery,
      repository: parsedBody.repository?.full_name,
      organization: parsedBody.organization?.login,
      sender: parsedBody.sender?.login,
      timestamp: new Date().toISOString(),
      payload: parsedBody,
    };

    // Firehoseにデータを送信
    const result = await sendToFirehose(
      data,
      process.env.DELIVERY_STREAM_NAME!,
    );

    // 成功レスポンスを返す
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Webhook received and processed successfully",
        recordId: result.RecordId,
        eventType: githubEvent,
      }),
    };
  } catch (error: any) {
    // エラーログを出力
    console.error("Error processing webhook:", error);

    // エラーレスポンスを返す
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Error processing webhook",
        error: error.message,
      }),
    };
  }
};
