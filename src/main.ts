import {
  App,
  Stack,
  StackProps,
  RemovalPolicy,
  Duration,
  CfnOutput,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as kinesisfirehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kinesis from "aws-cdk-lib/aws-kinesis";
import * as logs from "aws-cdk-lib/aws-logs";
import * as glue from "aws-cdk-lib/aws-glue";

export class GitHubActivityMetricsStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // S3バケット - GitHubデータの保存先
    const dataBucket = new s3.Bucket(this, "GitHubDataBucket", {
      removalPolicy: RemovalPolicy.RETAIN, // 本番環境ではデータ保持のため
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
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

    // Athenaクエリ結果用のS3バケット
    const athenaResultsBucket = new s3.Bucket(this, "AthenaResultsBucket", {
      removalPolicy: RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          expiration: Duration.days(30), // クエリ結果は30日後に削除
        },
      ],
    });

    // Glueデータベース（Athenaクエリ用）
    new glue.CfnDatabase(this, "GitHubDatabase", {
      catalogId: this.account,
      databaseInput: {
        name: "github_activity_db",
        description: "Database for GitHub activity data",
      },
    });

    // Kinesis Data Stream - リアルタイムデータ処理用
    const dataStream = new kinesis.Stream(this, "GitHubActivityStream", {
      streamName: "github-activity-stream",
      shardCount: 1, // 初期シャード数（トラフィックに応じて調整可能）
      retentionPeriod: Duration.hours(24),
    });

    // Lambda関数 - API Gateway Webhookハンドラー
    const webhookHandler = new lambda.Function(this, "WebhookHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const kinesis = new AWS.Kinesis();
        
        exports.handler = async (event) => {
          console.log('Received webhook event', { requestId: event.requestContext?.requestId });
          
          try {
            // GitHubイベントタイプの取得
            const githubEvent = event.headers['X-GitHub-Event'] || event.headers['x-github-event'];
            const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
            
            // パーティションキーの作成（リポジトリまたはランダム値）
            const partitionKey = body.repository?.full_name || Math.random().toString(36).substring(2, 15);
            
            // Kinesisストリームにデータを送信
            const params = {
              StreamName: process.env.KINESIS_STREAM_NAME,
              Data: JSON.stringify({
                githubEvent,
                headers: event.headers,
                body: body,
                receivedAt: new Date().toISOString()
              }),
              PartitionKey: partitionKey
            };
            
            await kinesis.putRecord(params).promise();
            
            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                message: 'Webhook received successfully',
                eventType: githubEvent
              })
            };
          } catch (error) {
            console.error('Error processing webhook:', error);
            
            return {
              statusCode: 500,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                message: 'Error processing webhook',
                error: error.message 
              })
            };
          }
        };
      `),
      environment: {
        KINESIS_STREAM_NAME: dataStream.streamName,
      },
      timeout: Duration.seconds(30),
      memorySize: 256,
    });

    // Lambda関数にKinesisストリームへの書き込み権限を付与
    dataStream.grantWrite(webhookHandler);

    // API Gateway - GitHubのWebhookを受け取るためのエンドポイント
    const api = new apigateway.RestApi(this, "GitHubWebhookApi", {
      restApiName: "GitHub Webhook API",
      description: "API Gateway for receiving GitHub webhooks",
      deployOptions: {
        stageName: "prod",
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
      },
    });

    // WebhookハンドラーとAPI Gatewayを統合
    const webhookIntegration = new apigateway.LambdaIntegration(webhookHandler);
    api.root.addMethod("POST", webhookIntegration);

    // Lambda関数 - データ変換処理
    const dataTransformer = new lambda.Function(this, "DataTransformer", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          // Firehoseからのレコードを処理
          const output = event.records.map(record => {
            try {
              // Base64でエンコードされたデータをデコード
              const payload = Buffer.from(record.data, 'base64').toString('utf-8');
              const parsedData = JSON.parse(payload);
              
              // GitHubイベント種別に特化した変換処理
              const githubEvent = parsedData.githubEvent;
              const body = parsedData.body;
              
              // イベントタイプに応じた変換ロジック
              let transformedData;
              switch (githubEvent) {
                case 'push':
                  transformedData = {
                    event_type: githubEvent,
                    repository: body.repository?.full_name,
                    organization: body.organization?.login,
                    sender: body.sender?.login,
                    ref: body.ref,
                    before: body.before,
                    after: body.after,
                    commits_count: body.commits?.length || 0,
                    timestamp: parsedData.receivedAt,
                  };
                  break;
                  
                case 'pull_request':
                  transformedData = {
                    event_type: githubEvent,
                    repository: body.repository?.full_name,
                    organization: body.organization?.login,
                    sender: body.sender?.login,
                    action: body.action,
                    pr_number: body.number,
                    pr_title: body.pull_request?.title,
                    pr_state: body.pull_request?.state,
                    timestamp: parsedData.receivedAt,
                  };
                  break;
                  
                // 他のイベントタイプも必要に応じて追加
                default:
                  // デフォルトの変換ロジック - 共通フィールドを抽出
                  transformedData = {
                    event_type: githubEvent,
                    repository: body.repository?.full_name,
                    organization: body.organization?.login,
                    sender: body.sender?.login,
                    timestamp: parsedData.receivedAt,
                    raw_payload: body, // 不明なイベントタイプの場合は生データを保持
                  };
              }
              
              // Base64エンコードして返す
              return {
                recordId: record.recordId,
                result: 'Ok',
                data: Buffer.from(JSON.stringify(transformedData)).toString('base64'),
              };
            } catch (error) {
              console.error('Error processing record:', error);
              // エラー時もレコードを保持（処理を継続）
              return {
                recordId: record.recordId,
                result: 'ProcessingFailed',
                data: record.data,
              };
            }
          });
          
          return { records: output };
        };
      `),
      timeout: Duration.minutes(2),
      memorySize: 256,
    });

    // リアルタイム処理のためのLambda関数（オプション）
    const streamProcessor = new lambda.Function(this, "StreamProcessor", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          console.log('Processing Kinesis records:', event.Records.length);
          
          // イベントレコードを処理
          for (const record of event.Records) {
            try {
              // Base64でエンコードされたデータをデコード
              const payload = Buffer.from(record.kinesis.data, 'base64').toString('utf-8');
              const data = JSON.parse(payload);
              
              // ここでリアルタイム処理のロジックを実装
              // 例: アラート送信、メトリクス集計、他のサービスへの通知など
              console.log('Processing event:', data.githubEvent, 'for repo:', data.body.repository?.full_name);
            } catch (error) {
              console.error('Error processing Kinesis record:', error);
            }
          }
          
          return { processed: event.Records.length };
        };
      `),
      timeout: Duration.minutes(1),
      memorySize: 256,
    });

    // Kinesisストリームからのイベントソースマッピング（リアルタイム処理用）
    new lambda.EventSourceMapping(this, "StreamProcessorEventSource", {
      target: streamProcessor,
      eventSourceArn: dataStream.streamArn,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 100,
      maxBatchingWindow: Duration.seconds(30),
      retryAttempts: 3,
    });

    // Kinesisストリームの読み取り権限をStreamProcessorに付与
    dataStream.grantRead(streamProcessor);

    // Firehose用のロググループ
    const firehoseLogGroup = new logs.LogGroup(this, "FirehoseLogGroup", {
      logGroupName: "/aws/kinesisfirehose/github-activity-delivery-stream",
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
    dataBucket.grantWrite(firehoseRole);

    // FirehoseにKinesis読み取り権限を付与
    dataStream.grantRead(firehoseRole);

    // FirehoseにLambda呼び出し権限を付与
    dataTransformer.grantInvoke(firehoseRole);

    // Kinesis Data Firehose - データをS3に保存
    const deliveryStream = new kinesisfirehose.CfnDeliveryStream(
      this,
      "GitHubActivityDeliveryStream",
      {
        deliveryStreamName: "github-activity-delivery-stream",
        deliveryStreamType: "KinesisStreamAsSource",
        kinesisStreamSourceConfiguration: {
          kinesisStreamArn: dataStream.streamArn,
          roleArn: firehoseRole.roleArn,
        },
        extendedS3DestinationConfiguration: {
          bucketArn: dataBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          bufferingHints: {
            intervalInSeconds: 60, // 1分ごとにバッファリング
            sizeInMBs: 5, // または5MBごと
          },
          // イベントタイプと日付でパーティショニング
          prefix:
            "github-events/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/hour=!{timestamp:HH}/",
          errorOutputPrefix:
            "errors/!{firehose:error-output-type}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/",
          // データ変換用のLambda関数を指定
          processingConfiguration: {
            enabled: true,
            processors: [
              {
                type: "Lambda",
                parameters: [
                  {
                    parameterName: "LambdaArn",
                    parameterValue: dataTransformer.functionArn,
                  },
                  {
                    parameterName: "BufferSizeInMBs",
                    parameterValue: "3",
                  },
                  {
                    parameterName: "BufferIntervalInSeconds",
                    parameterValue: "60",
                  },
                ],
              },
            ],
          },
          // 圧縮と形式の設定
          compressionFormat: "GZIP",
          // CloudWatchログの設定
          cloudWatchLoggingOptions: {
            enabled: true,
            logGroupName: firehoseLogGroup.logGroupName,
            logStreamName: "S3Delivery",
          },
        },
      },
    );

    // 出力値
    new CfnOutput(this, "WebhookApiUrl", {
      value: api.url,
      description: "GitHub Webhookを設定するためのURL",
    });

    new CfnOutput(this, "DataBucketName", {
      value: dataBucket.bucketName,
      description: "GitHubイベントが保存されるS3バケット",
    });

    new CfnOutput(this, "AthenaResultsBucketName", {
      value: athenaResultsBucket.bucketName,
      description: "Athenaクエリ結果が保存されるS3バケット",
    });

    new CfnOutput(this, "KinesisStreamName", {
      value: dataStream.streamName,
      description: "GitHubイベントを処理するKinesisストリーム",
    });

    new CfnOutput(this, "FirehoseStreamName", {
      value: deliveryStream.deliveryStreamName!,
      description: "GitHubイベントをS3に配信するFirehoseストリーム",
    });
  }
}

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new GitHubActivityMetricsStack(app, "github-activity-metrics-aws-dev", {
  env: devEnv,
});
// new GitHubActivityMetricsStack(app, 'github-activity-metrics-aws-prod', { env: prodEnv });

app.synth();
