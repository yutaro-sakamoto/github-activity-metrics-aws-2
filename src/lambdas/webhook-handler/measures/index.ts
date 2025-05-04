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

type measureType =
  | measureTypeAtom
  | {
      measureName: string;
      measureValueType: "MULTI";
      measureValues: {
        Name: string;
        Type: "BIGINT" | "DOUBLE" | "VARCHAR" | "BOOLEAN";
        Value: string;
      }[];
    };

/**
 * イベントタイプに応じたメジャー定義を取得する
 * @param event_type GitHubイベントタイプ
 * @param payload GitHubイベントのペイロードデータ
 * @returns Timestreamメジャー定義
 */
export function getMeasure(event_type: string, payload: any): measureType {
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
