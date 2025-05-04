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
    // https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request
    case "pull_request": {
      let measureValues: multiMeasureValuesType[] = [
        {
          Name: "pr_number",
          Type: "BIGINT",
          Value: String(payload.number),
        },
        {
          Name: "pr_action",
          Type: "VARCHAR",
          Value: payload.action,
        },
      ];
      if (payload.assignee) {
        measureValues.concat([
          {
            Name: "pr_assignee_login",
            Type: "VARCHAR",
            Value: payload.assignee.login,
          },
          {
            Name: "pr_assignee_id",
            Type: "BIGINT",
            Value: String(payload.assignee.id),
          },
        ]);
      }

      add_pull_request_object_infomation(measureValues, payload, "pr_");

      return {
        measureName: "pull_request",
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

/**
 * https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request
 * のpull_requestオブジェクトの情報をTimestreamのメジャー定義に追加する
 * @param measureValues
 * @param payload GitHub Webhookのペイロード
 * @param prefix Nameのprefix
 */
function add_pull_request_object_infomation(
  measureValues: multiMeasureValuesType[],
  payload: any,
  prefix: string,
) {
  measureValues.push(
    {
      Name: `${prefix}pr_author_association`,
      Type: "VARCHAR",
      Value: payload.pull_request.author_association,
    },
    {
      Name: `${prefix}pr_base_label`,
      Type: "VARCHAR",
      Value: payload.pull_request.base.label,
    },
    {
      Name: `${prefix}pr_base_ref`,
      Type: "VARCHAR",
      Value: payload.pull_request.base.ref,
    },
    {
      Name: `${prefix}pr_base_sha`,
      Type: "VARCHAR",
      Value: payload.pull_request.base.sha,
    },
    {
      Name: `${prefix}pr_commits`,
      Type: "BIGINT",
      Value: String(payload.pull_request.commits),
    },
    {
      Name: `${prefix}pr_created_at`,
      Type: "VARCHAR",
      Value: String(payload.pull_request.created_at),
    },
    {
      Name: `${prefix}pr_draft`,
      Type: "BOOLEAN",
      Value: String(payload.pull_request.draft),
    },
    {
      Name: `${prefix}pr_id`,
      Type: "BIGINT",
      Value: String(payload.pull_request.id),
    },
    {
      Name: `${prefix}pr_locked`,
      Type: "BOOLEAN",
      Value: String(payload.pull_request.locked),
    },
    {
      Name: `${prefix}pr_number`,
      Type: "BIGINT",
      Value: String(payload.pull_request.number),
    },
    {
      Name: `${prefix}pr_rv_comments`,
      Type: "BIGINT",
      Value: String(payload.pull_request.review_comments),
    },
    {
      Name: `${prefix}pr_state`,
      Type: "VARCHAR",
      Value: payload.pull_request.state,
    },
    {
      Name: `${prefix}pr_update_at`,
      Type: "VARCHAR",
      Value: payload.pull_request.updated_at,
    },
  );

  if (payload.pull_request.assignee) {
    measureValues.push({
      Name: `${prefix}pr_assignee_id`,
      Type: "BIGINT",
      Value: String(payload.pull_request.assignee.id),
    });
    measureValues.push({
      Name: `${prefix}pr_assignee_login`,
      Type: "BIGINT",
      Value: String(payload.pull_request.assignee.login),
    });
  }
  if (payload.pull_request.assignees) {
    const num_assignees = payload.pull_request.assignees.length;
    measureValues.push({
      Name: `${prefix}pr_assignees_length`,
      Type: "BIGINT",
      Value: String(num_assignees),
    });
    for (let i = 0; i < Math.min(num_assignees, 5); i++) {
      if (!payload.pull_request.assignees[i]) {
        continue;
      }
      measureValues.push({
        Name: `${prefix}pr_assignees_${i}_id`,
        Type: "BIGINT",
        Value: String(payload.pull_request.assignees[i].id),
      });
      measureValues.push({
        Name: `${prefix}pr_assignees_${i}_login`,
        Type: "BIGINT",
        Value: String(payload.pull_request.assignees[i].login),
      });
    }
  }
  if (payload.pull_request.auto_merge) {
    measureValues.push({
      Name: `${prefix}pr_auto_merge_merge_method`,
      Type: "BOOLEAN",
      Value: String(payload.pull_request.auto_merge.merge_method),
    });
  }
  if (payload.pull_request.base.user) {
    measureValues.push({
      Name: `${prefix}pr_base_user_id`,
      Type: "BIGINT",
      Value: String(payload.pull_request.base.user.id),
    });
    measureValues.push({
      Name: `${prefix}pr_base_user_login`,
      Type: "VARCHAR",
      Value: payload.pull_request.base.user.login,
    });
  }
  if (payload.pull_request.closed_at) {
    measureValues.push({
      Name: `${prefix}pr_closed_at`,
      Type: "VARCHAR",
      Value: payload.pull_request.closed_at,
    });
  }

  for (let i = 0; i < Math.min(payload.pull_request.labels.length, 5); i++) {
    measureValues.push({
      Name: `${prefix}pr_labels_${i}_name`,
      Type: "VARCHAR",
      Value: payload.pull_request.labels[i].name,
    });
  }

  if (payload.pull_request.merged !== null) {
    measureValues.push({
      Name: `${prefix}pr_merged`,
      Type: "BOOLEAN",
      Value: String(payload.pull_request.merged),
    });
  }

  if (payload.pull_request.merged_at) {
    measureValues.push({
      Name: `${prefix}pr_merged_at`,
      Type: "VARCHAR",
      Value: String(payload.pull_request.merged_at),
    });
  }

  if (payload.pull_request.merged_at) {
    measureValues.push({
      Name: `${prefix}pr_merged_at`,
      Type: "VARCHAR",
      Value: payload.pull_request.merged_at,
    });
  }

  if (payload.pull_request.user) {
    measureValues.push({
      Name: `${prefix}pr_user_id`,
      Type: "BIGINT",
      Value: String(payload.pull_request.user.id),
    });
    measureValues.push({
      Name: `${prefix}pr_user_login`,
      Type: "VARCHAR",
      Value: payload.pull_request.user.login,
    });
  }
}
