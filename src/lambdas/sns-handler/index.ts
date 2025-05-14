/**
 * SNS トピックから呼び出されるシンプルなLambda関数
 * メッセージを受信して標準出力に出力します
 */

export const handler = async (event: any, context: any) => {
  console.log("SNSイベントを受信しました");
  console.log("イベント:", JSON.stringify(event, null, 2));

  // SNSメッセージの処理
  try {
    // SNSイベントからメッセージを取得
    const records = event.Records || [];
    for (const record of records) {
      if (record.Sns) {
        const message = record.Sns.Message;
        console.log("SNSメッセージ:", message);

        // ここで必要な処理を追加できます
        // このシンプルな例では、メッセージを出力するだけです
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "SNSメッセージを正常に処理しました" }),
    };
  } catch (error) {
    console.error("エラーが発生しました:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "SNSメッセージの処理中にエラーが発生しました",
      }),
    };
  }
};
