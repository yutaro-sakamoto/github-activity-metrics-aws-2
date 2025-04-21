import { Construct } from "constructs";
import { RemovalPolicy, Duration } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import { NagSuppressions } from "cdk-nag";

export class Storage extends Construct {
  /**
   * GitHubのWebhookデータを格納するS3バケット
   */
  public readonly dataBucket: s3.Bucket;

  /**
   * Firehose配信ストリーム
   */
  public readonly deliveryStream: firehose.CfnDeliveryStream;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // S3バケット - アクセスログ用
    const accessLogsBucket = new s3.Bucket(this, "AccessLogsBucket", {
      removalPolicy: RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true, // SSL接続を強制
    });

    // S3バケット - GitHub Webhookデータの保存先
    this.dataBucket = new s3.Bucket(this, "GitHubWebhookDataBucket", {
      removalPolicy: RemovalPolicy.RETAIN, // 本番環境ではデータを保持
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true, // SSL接続を強制
      serverAccessLogsBucket: accessLogsBucket, // アクセスログを有効化
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

    // Firehose用のロググループ
    const firehoseLogGroup = new logs.LogGroup(this, "FirehoseLogGroup", {
      logGroupName: "/aws/kinesisfirehose/github-webhook-delivery",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Firehose用のIAMロール
    const firehoseRole = new iam.Role(this, "FirehoseRole", {
      assumedBy: new iam.ServicePrincipal("firehose.amazonaws.com"),
    });

    // Firehoseにログ書き込み権限を付与
    firehoseLogGroup.grantWrite(firehoseRole);

    // FirehoseにS3書き込み権限を付与
    this.dataBucket.grantWrite(firehoseRole);

    // Kinesis Data Firehose - データをS3に保存
    this.deliveryStream = new firehose.CfnDeliveryStream(
      this,
      "GitHubWebhookDeliveryStream",
      {
        deliveryStreamName: "github-webhook-delivery-stream",
        deliveryStreamType: "DirectPut",
        // サーバーサイド暗号化を有効化
        deliveryStreamEncryptionConfigurationInput: {
          keyType: "AWS_OWNED_CMK",
        },
        extendedS3DestinationConfiguration: {
          bucketArn: this.dataBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          bufferingHints: {
            intervalInSeconds: 60, // 1分ごとにバッファリング
            sizeInMBs: 5, // または5MBごと
          },
          // 動的パーティショニングを使わない標準的なプレフィックス
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

    // アクセスログバケットのCDK Nag抑制設定
    NagSuppressions.addResourceSuppressions(accessLogsBucket, [
      {
        id: "AwsSolutions-S1",
        reason:
          "アクセスログバケットに対するアクセスログは有効化しない（無限ループ防止）",
      },
    ]);
  }
}
