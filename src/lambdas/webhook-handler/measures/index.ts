/**
 * Returns Timestream measure definitions based on GitHub event types
 */

// The definition of measureType is based on the Timestream data types.
// See https://docs.aws.amazon.com/ja_jp/timestream/latest/developerguide/writes.html#writes.data-types for detail.

type measureTypeAtom = {
  measureName: string;
  measureValueType: "BIGINT" | "DOUBLE" | "VARCHAR" | "BOOLEAN";
  measureValue: string;
};

type multiMeasureValuesType = {
  Name: string;
  Type: "BIGINT" | "DOUBLE" | "VARCHAR" | "BOOLEAN" | "TIMESTAMP";
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
 * Get measure definition based on event type
 * @param event_type GitHub event type
 * @param payload GitHub event payload data
 * @returns Timestream measure definition
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
    // https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review
    case "pull_request_review": {
      let measureValues: multiMeasureValuesType[] = [
        {
          Name: "pr_rv_action",
          Type: "VARCHAR",
          Value: payload.action,
        },
        {
          Name: "pr_rv_review_author_association",
          Type: "VARCHAR",
          Value: payload.review.author_association,
        },
        {
          Name: "pr_rv_review_commit_id",
          Type: "VARCHAR",
          Value: payload.review.commit_id,
        },
        {
          Name: "pr_rv_review_id",
          Type: "VARCHAR",
          Value: String(payload.review.id),
        },
        {
          Name: "pr_rv_review_state",
          Type: "VARCHAR",
          Value: payload.review.state,
        },
        {
          Name: "pr_rv_review_submitted_at",
          Type: "TIMESTAMP",
          Value: formatTimestamp(payload.review.submitted_at),
        },
      ];

      if (payload.review.user) {
        measureValues.push({
          Name: "pr_rv_review_user_id",
          Type: "BIGINT",
          Value: String(payload.review.user.id),
        });
        measureValues.push({
          Name: "pr_rv_review_user_login",
          Type: "VARCHAR",
          Value: payload.review.user.login,
        });
      }

      add_pull_request_object_infomation(measureValues, payload, "pr_rv_");

      return {
        measureName: "pull_request",
        measureValueType: "MULTI",
        measureValues: measureValues,
      };
      return {
        measureName: "pull_request",
        measureValueType: "MULTI",
        measureValues: measureValues,
      };
    }
    case "issues": {
      let measureValues: multiMeasureValuesType[] = [
        {
          Name: "issues_action",
          Type: "VARCHAR",
          Value: payload.action,
        },
      ];
      if (payload.assignee) {
        measureValues.push(
          {
            Name: "issues_assignee_login",
            Type: "VARCHAR",
            Value: payload.assignee.login,
          },
          {
            Name: "issues_assignee_id",
            Type: "BIGINT",
            Value: String(payload.assignee.id),
          },
        );
      }

      add_issue_object_infomation(measureValues, payload, "issues_");
      return {
        measureName: "issue",
        measureValueType: "MULTI",
        measureValues: measureValues,
      };
    }
    // https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_run
    case "workflow_run": {
      let measureValues: multiMeasureValuesType[] = [];
      measureValues.push({
        Name: "wf_run_action",
        Type: "VARCHAR",
        Value: payload.action,
      });
      // workflow object
      measureValues.push(
        {
          Name: "wf_run_wf_created_at",
          Type: "TIMESTAMP",
          Value: formatTimestamp(payload.workflow.created_at),
        },
        {
          Name: "wf_run_wf_id",
          Type: "BIGINT",
          Value: String(payload.workflow.id),
        },
        {
          Name: "wf_run_wf_name",
          Type: "VARCHAR",
          Value: payload.workflow.name,
        },
        {
          Name: "wf_run_wf_path",
          Type: "VARCHAR",
          Value: payload.workflow.path,
        },
        {
          Name: "wf_run_wf_state",
          Type: "VARCHAR",
          Value: payload.workflow.state,
        },
        {
          Name: "wf_run_wf_updated_at",
          Type: "TIMESTAMP",
          Value: formatTimestamp(payload.workflow.updated_at),
        },
      );
      // workflow_run object
      measureValues.push(
        {
          Name: "wf_run_wf_run_actor_id",
          Type: "BIGINT",
          Value: String(payload.workflow_run.actor.id),
        },
        {
          Name: "wf_run_wf_run_actor_login",
          Type: "VARCHAR",
          Value: payload.workflow_run.actor.login,
        },
        {
          Name: "wf_run_wf_run_check_suite_id",
          Type: "BIGINT",
          Value: String(payload.workflow_run.check_suite_id),
        },
        {
          Name: "wf_run_wf_run_check_suite_node_id",
          Type: "VARCHAR",
          Value: payload.workflow_run.check_suite_node_id,
        },
      );
      if (payload.workflow_run.conclusion) {
        measureValues.push({
          Name: "wf_run_wf_run_conclusion",
          Type: "VARCHAR",
          Value: payload.workflow_run.conclusion,
        });
      }
      measureValues.push(
        {
          Name: "wf_run_wf_run_created_at",
          Type: "TIMESTAMP",
          Value: formatTimestamp(payload.workflow_run.created_at),
        },
        {
          Name: "wf_run_wf_run_event",
          Type: "VARCHAR",
          Value: payload.workflow_run.event,
        },
      );
      if (payload.workflow_run.head_branch) {
        measureValues.push({
          Name: "wf_run_wf_run_head_branch",
          Type: "VARCHAR",
          Value: payload.workflow_run.head_branch,
        });
      }
      measureValues.push({
        Name: "wf_run_wf_run_id",
        Type: "BIGINT",
        Value: String(payload.workflow_run.id),
      });
      if (payload.workflow_run.name) {
        measureValues.push({
          Name: "wf_run_wf_run_name",
          Type: "VARCHAR",
          Value: payload.workflow_run.name,
        });
      }
      measureValues.push(
        {
          Name: "wf_run_wf_run_node_id",
          Type: "VARCHAR",
          Value: payload.workflow_run.node_id,
        },
        {
          Name: "wf_run_wf_run_path",
          Type: "VARCHAR",
          Value: String(payload.workflow_run.path),
        },
        {
          Name: "wf_run_wf_run_attempt",
          Type: "BIGINT",
          Value: String(payload.workflow_run.run_attempt),
        },
        {
          Name: "wf_run_wf_run_number",
          Type: "BIGINT",
          Value: String(payload.workflow_run.run_number),
        },
        {
          Name: "wf_run_wf_run_started_at",
          Type: "TIMESTAMP",
          Value: formatTimestamp(payload.workflow_run.run_started_at),
        },
      );
      if (payload.workflow_run.triggering_actor) {
        measureValues.push(
          {
            Name: "wf_run_wf_run_triggering_actor_id",
            Type: "BIGINT",
            Value: String(payload.workflow_run.triggering_actor.id),
          },
          {
            Name: "wf_run_wf_run_triggering_actor_login",
            Type: "VARCHAR",
            Value: payload.workflow_run.triggering_actor.login,
          },
        );
      }
      measureValues.push(
        {
          Name: "wf_run_wf_run_updated_at",
          Type: "TIMESTAMP",
          Value: formatTimestamp(payload.workflow_run.updated_at),
        },
        {
          Name: "wf_run_wf_run_wf_id",
          Type: "BIGINT",
          Value: String(payload.workflow_run.workflow_id),
        },
      );
      return {
        measureName: "workflow_run",
        measureValueType: "MULTI",
        measureValues: measureValues,
      };
    }
  }
  return {
    measureName: "dummyMeasure",
    measureValueType: "BIGINT",
    measureValue: "1",
  };
}

/**
 * Add information from pull_request object to Timestream measure definitions
 * Based on:
 * * https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request
 * * https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review_comment
 *
 * @param measureValues Array of measure values to add data to
 * @param payload GitHub Webhook payload
 * @param prefix Prefix to add to the Name field
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
      Name: `${prefix}pr_created_at`,
      Type: "TIMESTAMP",
      Value: formatTimestamp(payload.pull_request.created_at),
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
      Name: `${prefix}pr_state`,
      Type: "VARCHAR",
      Value: payload.pull_request.state,
    },
    {
      Name: `${prefix}pr_update_at`,
      Type: "TIMESTAMP",
      Value: formatTimestamp(payload.pull_request.updated_at),
    },
  );

  if (payload.pull_request.commits) {
    measureValues.push({
      Name: `${prefix}pr_commits`,
      Type: "BIGINT",
      Value: String(payload.pull_request.commits),
    });
  }

  if (payload.pull_request.review_comments) {
    measureValues.push({
      Name: `${prefix}pr_rv_comments`,
      Type: "BIGINT",
      Value: String(payload.pull_request.review_comments),
    });
  }

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
      Type: "TIMESTAMP",
      Value: formatTimestamp(payload.pull_request.closed_at),
    });
  }

  for (let i = 0; i < Math.min(payload.pull_request.labels.length, 5); i++) {
    measureValues.push({
      Name: `${prefix}pr_labels_${i}_name`,
      Type: "VARCHAR",
      Value: payload.pull_request.labels[i].name,
    });
  }

  if (
    payload.pull_request.merged !== undefined &&
    payload.pull_request.merged !== null
  ) {
    measureValues.push({
      Name: `${prefix}pr_merged`,
      Type: "BOOLEAN",
      Value: String(payload.pull_request.merged),
    });
  }

  if (payload.pull_request.merged_at) {
    measureValues.push({
      Name: `${prefix}pr_merged_at`,
      Type: "TIMESTAMP",
      Value: formatTimestamp(payload.pull_request.merged_at),
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

/**
 * Converts an ISO 8601 formatted timestamp string to milliseconds since Unix epoch
 *
 * @param isoTimestamp ISO 8601 formatted timestamp string (e.g. 2025-05-04T10:41:38Z)
 * @returns String representing milliseconds since Unix epoch
 */
export function formatTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return String(date.getTime());
}

/**
 * Add information from issue object to Timestream measure definitions
 * Based on:
 * * https://docs.github.com/en/webhooks/webhook-events-and-payloads#issues
 *
 * @param measureValues Array of measure values to add data to
 * @param payload GitHub Webhook payload
 * @param prefix Prefix to add to the Name field
 */
function add_issue_object_infomation(
  measureValues: multiMeasureValuesType[],
  payload: any,
  prefix: string,
) {
  if (payload.issue.asignee) {
    measureValues.push(
      {
        Name: `${prefix}issue_assignee_login`,
        Type: "VARCHAR",
        Value: payload.issue.assignee.login,
      },
      {
        Name: `${prefix}issue_assignee_id`,
        Type: "BIGINT",
        Value: String(payload.issue.assignee.id),
      },
    );
  }
  let asignee_length = payload.issue.assignees.length;
  measureValues.push({
    Name: `${prefix}issue_assignees_length`,
    Type: "BIGINT",
    Value: String(asignee_length),
  });
  for (let i = 0; i < Math.min(asignee_length, 5); i++) {
    measureValues.push(
      {
        Name: `${prefix}issue_assignees_${i}_login`,
        Type: "VARCHAR",
        Value: payload.issue.assignees[i].login,
      },
      {
        Name: `${prefix}issue_assignees_${i}_id`,
        Type: "BIGINT",
        Value: String(payload.issue.assignees[i].id),
      },
    );
  }
  measureValues.push({
    Name: `${prefix}issue_author_association`,
    Type: "VARCHAR",
    Value: payload.issue.author_association,
  });
  if (payload.issue.closed_at) {
    measureValues.push({
      Name: `${prefix}issue_closed_at`,
      Type: "TIMESTAMP",
      Value: formatTimestamp(payload.issue.closed_at),
    });
  }
  measureValues.push({
    Name: `${prefix}issue_comments`,
    Type: "BIGINT",
    Value: String(payload.issue.comments),
  });
  if (payload.issue.created_at) {
    measureValues.push({
      Name: `${prefix}issue_created_at`,
      Type: "TIMESTAMP",
      Value: formatTimestamp(payload.issue.created_at),
    });
  }
  if (payload.issue.draft !== undefined && payload.issue.draft !== null) {
    measureValues.push({
      Name: `${prefix}issue_draft`,
      Type: "BOOLEAN",
      Value: String(payload.issue.draft),
    });
  }
  measureValues.push({
    Name: `${prefix}issue_id`,
    Type: "BIGINT",
    Value: String(payload.issue.id),
  });
  let labels_length = payload.issue.labels.length;
  measureValues.push({
    Name: `${prefix}issue_labels_length`,
    Type: "BIGINT",
    Value: String(labels_length),
  });
  for (let i = 0; i < Math.min(labels_length, 5); i++) {
    measureValues.push(
      {
        Name: `${prefix}issue_labels_${i}_name`,
        Type: "VARCHAR",
        Value: payload.issue.labels[i].name,
      },
      {
        Name: `${prefix}issue_labels_${i}_id`,
        Type: "BIGINT",
        Value: String(payload.issue.labels[i].id),
      },
      {
        Name: `${prefix}issue_labels_${i}_default`,
        Type: "BOOLEAN",
        Value: String(payload.issue.labels[i].default),
      },
    );
  }
  measureValues.push({
    Name: `${prefix}issue_locked`,
    Type: "BOOLEAN",
    Value: String(payload.issue.locked),
  });
  measureValues.push({
    Name: `${prefix}issue_number`,
    Type: "BIGINT",
    Value: String(payload.issue.number),
  });
  measureValues.push({
    Name: `${prefix}issue_state`,
    Type: "VARCHAR",
    Value: payload.issue.state,
  });
  if (payload.issue.updated_at) {
    measureValues.push({
      Name: `${prefix}issue_updated_at`,
      Type: "TIMESTAMP",
      Value: formatTimestamp(payload.issue.updated_at),
    });
  }
  if (payload.issue.user) {
    measureValues.push(
      {
        Name: `${prefix}issue_user_id`,
        Type: "BIGINT",
        Value: String(payload.issue.user.id),
      },
      {
        Name: `${prefix}issue_user_login`,
        Type: "VARCHAR",
        Value: payload.issue.user.login,
      },
    );
  }
}
