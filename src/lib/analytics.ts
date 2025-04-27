// filepath: /home/main/project/github-activity-metrics-aws/src/lib/analytics.ts
import { RemovalPolicy, Stack } from "aws-cdk-lib";
import * as athena from "aws-cdk-lib/aws-athena";
import * as glue from "aws-cdk-lib/aws-glue";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";

export interface AnalyticsProps {
  /**
   * S3 bucket containing GitHub webhook data
   */
  dataBucket: s3.Bucket;
}

export class Analytics extends Construct {
  /**
   * Athena workgroup for GitHub webhook analysis
   */
  public readonly workgroup: athena.CfnWorkGroup;

  /**
   * Glue database for GitHub webhook data
   */
  public readonly database: glue.CfnDatabase;

  constructor(scope: Construct, id: string, props: AnalyticsProps) {
    super(scope, id);

    const { dataBucket } = props;

    // Create a bucket for Athena query results
    const athenaResultsBucket = new s3.Bucket(this, "AthenaResultsBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    // QuickSight用にバケットポリシーを追加
    const quickSightPrincipal = new iam.ServicePrincipal(
      "quicksight.amazonaws.com",
    );

    // QuickSightに結果バケットへのアクセス許可を与える
    athenaResultsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [quickSightPrincipal],
        actions: ["s3:*"],
        resources: [
          athenaResultsBucket.bucketArn,
          `${athenaResultsBucket.bucketArn}/*`,
        ],
      }),
    );

    // データバケットにもQuickSightからのアクセス権限を与える
    dataBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [quickSightPrincipal],
        actions: ["s3:*"],
        resources: [dataBucket.bucketArn, `${dataBucket.bucketArn}/*`],
      }),
    );

    NagSuppressions.addResourceSuppressions(athenaResultsBucket, [
      {
        id: "AwsSolutions-S1",
        reason: "Access logs are not enabled for the access logs bucket",
      },
    ]);

    // Create a Glue database for GitHub webhook data
    this.database = new glue.CfnDatabase(this, "GitHubWebhookDatabase", {
      catalogId: Stack.of(this).account,
      databaseInput: {
        name: "github_webhooks_db",
        description: "Database for GitHub webhook data analysis",
      },
    });

    // Create Glue table for webhook data
    const webhookTable = new glue.CfnTable(this, "WebhookTable", {
      catalogId: Stack.of(this).account,
      databaseName: this.database.ref,
      tableInput: {
        name: "github_webhook_events",
        description: "GitHub webhook events data",
        tableType: "EXTERNAL_TABLE",
        parameters: {
          // データ形式に基づいて適切なタイプを設定
          // JSON形式の場合
          classification: "json",
          compressionType: "gzip",

          // Parquet形式の場合はこちらを使用（JSONの設定を削除）
          // "classification": "parquet",
          // "compressionType": "snappy",

          typeOfData: "file",
          // パーティションプロジェクションを有効化
          "projection.enabled": "true",
          "projection.year.type": "integer",
          "projection.year.range": "2020,2030",
          "projection.month.type": "integer",
          "projection.month.range": "1,12",
          "projection.month.digits": "2",
          "projection.day.type": "integer",
          "projection.day.range": "1,31",
          "projection.day.digits": "2",
          "storage.location.template":
            `s3://${dataBucket.bucketName}/github-webhooks/` +
            "year=${year}/month=${month}/day=${day}/",
        },
        partitionKeys: [
          { name: "year", type: "string" },
          { name: "month", type: "string" },
          { name: "day", type: "string" },
        ],
        storageDescriptor: {
          location: `s3://${dataBucket.bucketName}/github-webhooks/`,
          inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat:
            "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          compressed: true,
          serdeInfo: {
            serializationLibrary: "org.openx.data.jsonserde.JsonSerDe",
            parameters: {
              "serialization.format": "1",
              "case.insensitive": "true",
              "ignore.malformed.json": "true",
            },
          },
          // GitHub Webhookのペイロードの主要なフィールドを定義
          columns: [
            { name: "action", type: "string" },
            {
              name: "repository",
              type: "struct<id:bigint,name:string,full_name:string>",
            },
            { name: "organization", type: "struct<login:string,id:bigint>" },
            { name: "sender", type: "struct<login:string,id:bigint>" },
            { name: "event_type", type: "string" },
            { name: "delivery_id", type: "string" },
            { name: "payload", type: "string" },
          ],
        },
      },
    });

    // Create Athena workgroup
    this.workgroup = new athena.CfnWorkGroup(this, "GitHubWebhooksWorkgroup", {
      name: "github-webhooks-workgroup",
      description: "Workgroup for analyzing GitHub webhook data",
      state: "ENABLED",
      workGroupConfiguration: {
        resultConfiguration: {
          outputLocation: `s3://${athenaResultsBucket.bucketName}/results/`,
          encryptionConfiguration: {
            encryptionOption: "SSE_S3",
          },
        },
        publishCloudWatchMetricsEnabled: true,
        enforceWorkGroupConfiguration: true,
        bytesScannedCutoffPerQuery: 10737418240, // 10GB
      },
    });

    // Create a view for daily issue creation count
    new athena.CfnNamedQuery(this, "CreateDailyIssueCountView", {
      database: this.database.ref,
      name: "Create Daily Issue Count View",
      description: "Creates a view for daily issue creation metrics",
      queryString: `
        CREATE OR REPLACE VIEW daily_issue_creation AS
        SELECT 
          CONCAT(year, '-', month, '-', day) AS date_str,
          CAST(CONCAT(year, '-', month, '-', day) AS date) AS issue_date,
          COUNT(*) AS issues_created
        FROM 
          "${this.database.ref}"."${webhookTable.ref}"
        WHERE 
          event_type = 'issues'
          AND action = 'opened'
        GROUP BY 
          year, month, day
        ORDER BY 
          issue_date;
      `,
      workGroup: this.workgroup.ref,
    });

    // Add a query to select from the view
    new athena.CfnNamedQuery(this, "DailyIssueCountQuery", {
      database: this.database.ref,
      name: "Daily Issue Creation Count",
      description: "Returns the daily count of created issues",
      queryString: `
        SELECT *
        FROM daily_issue_creation
        ORDER BY issue_date;
      `,
      workGroup: this.workgroup.ref,
    });
  }
}
