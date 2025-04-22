import { RemovalPolicy, Duration } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

export class Storage extends Construct {
  /**
   * S3 bucket that stores GitHub webhook data
   */
  public readonly dataBucket: s3.Bucket;

  /**
   * Firehose delivery stream
   */
  public readonly deliveryStream: firehose.CfnDeliveryStream;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // S3 bucket - for access logs
    const accessLogsBucket = new s3.Bucket(this, "AccessLogsBucket", {
      removalPolicy: RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true, // Enforce SSL connections
    });

    // S3 bucket - Destination for GitHub webhook data
    this.dataBucket = new s3.Bucket(this, "GitHubWebhookDataBucket", {
      removalPolicy: RemovalPolicy.RETAIN, // Retain data in production environment
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

    // Log group for Firehose
    const firehoseLogGroup = new logs.LogGroup(this, "FirehoseLogGroup", {
      logGroupName: "/aws/kinesisfirehose/github-webhook-delivery",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // IAM role for Firehose
    const firehoseRole = new iam.Role(this, "FirehoseRole", {
      assumedBy: new iam.ServicePrincipal("firehose.amazonaws.com"),
    });

    // Grant log writing permissions to Firehose
    firehoseLogGroup.grantWrite(firehoseRole);

    // Grant S3 writing permissions to Firehose
    this.dataBucket.grantWrite(firehoseRole);

    // Kinesis Data Firehose - Save data to S3
    this.deliveryStream = new firehose.CfnDeliveryStream(
      this,
      "GitHubWebhookDeliveryStream",
      {
        deliveryStreamName: "github-webhook-delivery-stream",
        deliveryStreamType: "DirectPut",
        // Enable server-side encryption
        deliveryStreamEncryptionConfigurationInput: {
          keyType: "AWS_OWNED_CMK",
        },
        extendedS3DestinationConfiguration: {
          bucketArn: this.dataBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          bufferingHints: {
            intervalInSeconds: 60, // Buffer every 1 minute
            sizeInMBs: 5, // Or every 5MB
          },
          // Standard prefix without dynamic partitioning
          prefix:
            "github-webhooks/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/",
          errorOutputPrefix:
            "errors/!{firehose:error-output-type}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/",
          compressionFormat: "GZIP",
          cloudWatchLoggingOptions: {
            enabled: true,
            logGroupName: firehoseLogGroup.logGroupName,
            logStreamName: "S3Delivery",
          },
        },
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
