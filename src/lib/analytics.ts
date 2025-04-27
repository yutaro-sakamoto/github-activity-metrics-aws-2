// filepath: /home/main/project/github-activity-metrics-aws/src/lib/analytics.ts
import { RemovalPolicy, Stack } from "aws-cdk-lib";
import * as athena from "aws-cdk-lib/aws-athena";
import * as glue from "@aws-cdk/aws-glue-alpha";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";

export interface AnalyticsProps {
  /**
   * S3 bucket containing GitHub webhook data
   */
  dataBucket: s3.Bucket;

  /**
   * Firehose schema role
   */
  firehoseSchemaRole: iam.Role;

  /**
   * Firehose delivery stream
   */
  firehoseDeliveryStream: firehose.DeliveryStream;
}

export class Analytics extends Construct {
  /**
   * Athena workgroup for GitHub webhook analysis
   */
  public readonly workgroup: athena.CfnWorkGroup;

  /**
   * Glue database for GitHub webhook data
   */
  public readonly database: glue.Database;

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
    this.database = new glue.Database(this, "GitHubWebhookDatabase", {
      databaseName: "github_webhooks_db",
    });

    // Create Glue table for webhook data
    const webhookTable = new glue.S3Table(this, "WebhookTable", {
      database: this.database,
      bucket: dataBucket,
      tableName: "github_webhook_events",
      description: "GitHub webhook events data",
      columns: [
        { name: "action", type: glue.Schema.STRING },
        {
          name: "repository",
          type: glue.Schema.struct([
            { name: "id", type: glue.Schema.BIG_INT },
            { name: "name", type: glue.Schema.STRING },
            { name: "full_name", type: glue.Schema.STRING },
          ]),
        },
        {
          name: "organization",
          type: glue.Schema.struct([
            { name: "login", type: glue.Schema.STRING },
            { name: "id", type: glue.Schema.BIG_INT },
          ]),
        },
        {
          name: "sender",
          type: glue.Schema.struct([
            { name: "login", type: glue.Schema.STRING },
            { name: "id", type: glue.Schema.BIG_INT },
          ]),
        },
        { name: "event_type", type: glue.Schema.STRING },
        { name: "delivery_id", type: glue.Schema.STRING },
        { name: "payload", type: glue.Schema.STRING },
      ],
      partitionKeys: [
        { name: "year", type: glue.Schema.STRING },
        { name: "month", type: glue.Schema.STRING },
        { name: "day", type: glue.Schema.STRING },
      ],
      parameters: {
        "projection.enabled": "true",
        "storage.location.template":
          `s3://${dataBucket.bucketName}` +
          "/github-webhooks/year=${year}/month=${month}/day=${day}/",
        "projection.year.type": "integer",
        "projection.year.range": "2000,2100",
        "projection.month.type": "integer",
        "projection.month.range": "1,12",
        "projection.month.digits": "2",
        "projection.day.type": "integer",
        "projection.day.range": "1,31",
        "projection.day.digits": "2",
      },
      dataFormat: glue.DataFormat.PARQUET,
      compressed: true,
      storageParameters: [
        glue.StorageParameter.compressionType(glue.CompressionType.SNAPPY),
      ],
    });

    // 特定のテーブルに対するアクセス許可を付与
    webhookTable.grantRead(props.firehoseSchemaRole);

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

    const cfnFirehoseStream = props.firehoseDeliveryStream.node
      .defaultChild as firehose.CfnDeliveryStream;

    cfnFirehoseStream.addPropertyOverride(
      "ExtendedS3DestinationConfiguration.DynamicPartitioningConfiguration",
      { Enabled: false },
    );

    cfnFirehoseStream.addPropertyOverride(
      "ExtendedS3DestinationConfiguration.DataFormatConversionConfiguration",
      /**
       * Glue TableのSchemaを参照してparquetに変換する設定
       */
      {
        Enabled: true,
        /** Glue Tableへの参照 */
        SchemaConfiguration: {
          CatalogId: this.database.catalogId,
          RoleARN: props.firehoseSchemaRole.roleArn,
          DatabaseName: this.database.databaseName,
          TableName: webhookTable.tableName,
          Region: Stack.of(this).region,
          VersionId: "LATEST",
        },

        /**
         * 入力設定
         * glueでは列名に大文字を含めることができないため、ここで小文字に変換する
         */
        InputFormatConfiguration: {
          Deserializer: {
            OpenXJsonSerDe: { CaseInsensitive: false },
          },
        },
        /**
         * 出力設定
         * SNAPPYで圧縮したparquetを出力する
         */
        OutputFormatConfiguration: {
          Serializer: {
            ParquetSerDe: { Compression: "SNAPPY" },
          },
        },
      },
    );
  }
}
