/**
 * GitHub イベントタイプに基づいて Timestream のメジャー定義を返す
 */

/**
 * イベントタイプに応じたメジャー定義を取得する
 * @param event_type GitHubイベントタイプ
 * @param payload GitHubイベントのペイロードデータ
 * @returns Timestreamメジャー定義
 */
export function getMeasure(event_type: string, payload: any): any {
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
