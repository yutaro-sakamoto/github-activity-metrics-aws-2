/**
 * GitHub イベントタイプに基づいて Timestream のメジャー定義を返す
 */

// The definition of measureType is based on the Timestream data types.
// See https://docs.aws.amazon.com/ja_jp/timestream/latest/developerguide/writes.html#writes.data-types for detail.

type measureTypeAtom =
  | {
      measureName: string;
      measureValueType: "BIGINT" | "DOUBLE";
      measureValue: number;
    }
  | {
      measureName: string;
      measureValueType: "VARCHAR";
      measureValue: string;
    }
  | {
      measureName: string;
      measureValueType: "BOOLEAN";
      measureValue: boolean;
    };

type multiMeasureValuesType = {
  Name: string;
  Type: "BIGINT" | "DOUBLE" | "VARCHAR" | "BOOLEAN";
  Value: string;
};

type measureType =
  | measureTypeAtom
  | {
      measureName: string;
      measureValueType: "MULTI";
      measureValues: multiMeasureValuesType[];
    };

/**
 * イベントタイプに応じたメジャー定義を取得する
 * @param event_type GitHubイベントタイプ
 * @param payload GitHubイベントのペイロードデータ
 * @returns Timestreamメジャー定義
 */
export function getMeasure(event_type: string, payload: any): measureType {
  switch (event_type) {
    // https://docs.github.com/en/webhooks/webhook-events-and-payloads#push
    case "push": {
      let measureValues: multiMeasureValuesType[] = [
        {
          Name: "push_after",
          Type: "VARCHAR",
          Value: payload.after,
        },
        {
          Name: "push_before",
          Type: "VARCHAR",
          Value: payload.before,
        },
        {
          Name: "push_commits_length",
          Type: "BIGINT",
          Value: String(payload.commits.length),
        },
        {
          Name: "push_created",
          Type: "BOOLEAN",
          Value: String(payload.created),
        },
        {
          Name: "push_deleted",
          Type: "BOOLEAN",
          Value: String(payload.deleted),
        },
        {
          Name: "push_forced",
          Type: "BOOLEAN",
          Value: String(payload.forced),
        },
        {
          Name: "push_pusher_name",
          Type: "VARCHAR",
          Value: payload.pusher.name,
        },
        {
          Name: "push_ref",
          Type: "VARCHAR",
          Value: payload.ref,
        },
      ];
      if (payload.base_ref) {
        measureValues.push({
          Name: "push_base_ref",
          Type: "VARCHAR",
          Value: payload.base_ref,
        });
      }
      return {
        measureName: "push",
        measureValueType: "MULTI",
        measureValues: measureValues,
      };
    }
  }
  return {
    measureName: "dummyMeasure",
    measureValueType: "BIGINT",
    measureValue: 1,
  };
}
