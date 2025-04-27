import { RemovalPolicy, Duration, Size } from "aws-cdk-lib";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
//import * as destinations from "aws-cdk-lib/aws-kinesisfirehose-destinations";
//import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";

export class Storage extends Construct {
  /**
   * S3 bucket that stores GitHub webhook data
   */
  public readonly dataBucket: s3.Bucket;

  /**
   * Firehose delivery stream
   */
  public readonly deliveryStream: firehose.DeliveryStream;

  /**
   * IAM role for Firehose schema
   */
  public readonly firehoseSchemaRole: iam.Role;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // S3 bucket - for access logs
    const accessLogsBucket = new s3.Bucket(this, "AccessLogsBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true, // Enforce SSL connections
    });

    // S3 bucket - Destination for GitHub webhook data
    this.dataBucket = new s3.Bucket(this, "GitHubWebhookDataBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true, // Enforce SSL connections
      serverAccessLogsBucket: accessLogsBucket, // Enable access logs
      serverAccessLogsPrefix: "github-webhook-data-access-logs/",
      lifecycleRules: [
        {
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: Duration.days(90),
            },
          ],
        },
      ],
    });

    // Athenaに最適なパーティショニングを設定
    const s3Prefix =
      "github-webhooks/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/";
    const errorPrefix =
      "errors/!{firehose:error-output-type}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/";

    // S3宛先の設定
    const s3Destination = new firehose.S3Bucket(this.dataBucket, {
      compression: firehose.Compression.UNCOMPRESSED, // Parquet変換時はUNCOMPRESSEDに設定
      dataOutputPrefix: s3Prefix,
      errorOutputPrefix: errorPrefix,
      bufferingInterval: Duration.minutes(1),
      bufferingSize: Size.mebibytes(64),
    });

    this.firehoseSchemaRole = new iam.Role(this, "FirehoseSchemaRole", {
      assumedBy: new iam.ServicePrincipal("firehose.amazonaws.com"),
      inlinePolicies: {
        catalogPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["glue:GetTableVersions"],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    // DeliveryStreamを作成（L2コンストラクト）
    this.deliveryStream = new firehose.DeliveryStream(
      this,
      "GitHubWebhookDeliveryStream",
      {
        deliveryStreamName: "github-webhook-delivery-stream",
        destination: s3Destination,
        encryption: firehose.StreamEncryption.awsOwnedKey(),
      },
    );

    // CDK Nag suppression settings for access log bucket
    NagSuppressions.addResourceSuppressions(accessLogsBucket, [
      {
        id: "AwsSolutions-S1",
        reason:
          "Access logs are not enabled for the access logs bucket (prevents infinite loop)",
      },
    ]);
  }
}
