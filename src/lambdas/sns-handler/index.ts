/**
 * SNS トピックから呼び出されるシンプルなLambda関数
 * メッセージを受信して標準出力に出力します
 */

export const handler = async (event: any, context: any) => {
  console.log("event:", JSON.stringify(event));
  console.log("context:", JSON.stringify(context));

  // SNSメッセージの処理
  try {
    // SNSイベントからメッセージを取得
    const records = event.Records || [];
    for (const record of records) {
      if (record.Sns) {
        const message = record.Sns.Message;
        console.log("SNS message:", message);

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
