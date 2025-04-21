import {
  App,
  Stack,
  StackProps,
  RemovalPolicy,
  Duration,
  CfnOutput,
  Aspects,
} from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";

export class GitHubActivityMetricsStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // S3バケット - GitHub Webhookデータの保存先
    const accessLogsBucket = new s3.Bucket(this, "AccessLogsBucket", {
      removalPolicy: RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true, // SSL接続を強制
    });

    // S3バケット - GitHub Webhookデータの保存先
    const dataBucket = new s3.Bucket(this, "GitHubWebhookDataBucket", {
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
    dataBucket.grantWrite(firehoseRole);

    // Kinesis Data Firehose - データをS3に保存
    const deliveryStream = new firehose.CfnDeliveryStream(
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
          bucketArn: dataBucket.bucketArn,
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

    // API Gatewayのアクセスログバケットとロググループを作成
    const apiGatewayAccessLogsBucket = new s3.Bucket(
      this,
      "ApiGatewayAccessLogsBucket",
      {
        removalPolicy: RemovalPolicy.RETAIN,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
      },
    );

    NagSuppressions.addResourceSuppressions(apiGatewayAccessLogsBucket, [
      {
        id: "AwsSolutions-S1",
        reason: "アクセスログバケットに対するアクセスログは有効化しない",
      },
    ]);

    // REST API Gateway (GitHub Webhook用)
    const api = new apigateway.RestApi(this, "GitHubWebhookApi", {
      restApiName: "GitHub Webhook API",
      description: "API for receiving GitHub webhooks",
      deployOptions: {
        stageName: "v1",
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        // アクセスログを有効化
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new logs.LogGroup(this, "ApiGatewayAccessLogs", {
            retention: logs.RetentionDays.ONE_MONTH,
          }),
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
    });

    // SSMパラメータからGitHub Webhookのシークレットを参照
    const webhookSecretParam =
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        "GitHubWebhookSecret",
        {
          parameterName: "/github/metrics/secret-token",
          version: 1, // 特定のバージョンを指定するか、未指定で最新を使用
        },
      );

    // Lambda関数 - GitHubのWebhookを検証して、Firehoseにデータを送信する
    const webhookHandler = new lambda.Function(this, "WebhookHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const crypto = require('crypto');
        
        const ssm = new AWS.SSM();
        const firehose = new AWS.Firehose();
        
        // SSMパラメータストアからシークレットを取得する関数
        async function getSecretFromParameterStore(parameterName) {
          const params = {
            Name: parameterName,
            WithDecryption: true
          };
          
          try {
            const response = await ssm.getParameter(params).promise();
            return response.Parameter.Value;
          } catch (error) {
            console.error('Error fetching parameter from SSM:', error);
            throw error;
          }
        }
        
        // GitHubのシグネチャを検証する関数
        function verifySignature(payload, signature, secret) {
          try {
            // X-Hub-Signature-256があるか確認
            if (!signature || !signature.startsWith('sha256=')) {
              return false;
            }
            
            // シグネチャをパース
            const signatureHash = signature.substring(7); // 'sha256=' を除去
            
            // 期待されるシグネチャを計算
            const hmac = crypto.createHmac('sha256', secret);
            const calculatedSignature = hmac.update(payload).digest('hex');
            
            // タイミング攻撃を防ぐための比較
            return crypto.timingSafeEqual(
              Buffer.from(signatureHash, 'hex'),
              Buffer.from(calculatedSignature, 'hex')
            );
          } catch (error) {
            console.error('Signature verification error:', error);
            return false;
          }
        }
        
        // Firehoseにデータを送信する関数
        async function sendToFirehose(data, deliveryStreamName) {
          const params = {
            DeliveryStreamName: deliveryStreamName,
            Record: {
              Data: JSON.stringify(data)
            }
          };
          
          try {
            const result = await firehose.putRecord(params).promise();
            return result;
          } catch (error) {
            console.error('Error sending data to Firehose:', error);
            throw error;
          }
        }
        
        // Lambda関数のメインハンドラー
        exports.handler = async (event) => {
          console.log('Received webhook event');
          
          try {
            // リクエストボディとヘッダーの取得
            const body = event.body;
            const headers = event.headers || {};
            
            // GitHubのイベントタイプとdelivery IDを取得
            const githubEvent = headers['X-GitHub-Event'] || headers['x-github-event'];
            const githubDelivery = headers['X-GitHub-Delivery'] || headers['x-github-delivery'];
            const signature = headers['X-Hub-Signature-256'] || headers['x-hub-signature-256'];
            
            // リクエストボディが存在するかチェック
            if (!body) {
              console.error('No request body found');
              return {
                statusCode: 400,
                body: JSON.stringify({ message: 'No request body provided' })
              };
            }
            
            // SSMパラメータストアからシークレットを取得
            const secretToken = await getSecretFromParameterStore('/github/metrics/secret-token');
            
            // GitHub webhookシグネチャを検証
            const isValid = verifySignature(
              typeof body === 'string' ? body : JSON.stringify(body),
              signature,
              secretToken
            );
            
            if (!isValid) {
              console.error('Invalid signature');
              return {
                statusCode: 401,
                body: JSON.stringify({ message: 'Invalid signature' })
              };
            }
            
            // リクエストボディをパース（必要に応じて）
            const parsedBody = typeof body === 'string' ? JSON.parse(body) : body;
            
            // Firehoseに送信するデータを準備
            const data = {
              event_type: githubEvent,
              delivery_id: githubDelivery,
              repository: parsedBody.repository?.full_name,
              organization: parsedBody.organization?.login,
              sender: parsedBody.sender?.login,
              timestamp: new Date().toISOString(),
              payload: parsedBody
            };
            
            // Firehoseにデータを送信
            const result = await sendToFirehose(data, process.env.DELIVERY_STREAM_NAME);
            
            // 成功レスポンスを返す
            return {
              statusCode: 200,
              body: JSON.stringify({
                message: 'Webhook received and processed successfully',
                recordId: result.RecordId,
                eventType: githubEvent
              })
            };
          } catch (error) {
            // エラーログを出力
            console.error('Error processing webhook:', error);
            
            // エラーレスポンスを返す
            return {
              statusCode: 500,
              body: JSON.stringify({
                message: 'Error processing webhook',
                error: error.message
              })
            };
          }
        };
      `),
      environment: {
        DELIVERY_STREAM_NAME: deliveryStream.ref,
      },
      timeout: Duration.seconds(30),
      memorySize: 256,
    });

    // Lambda関数にSSMパラメータ読み取り権限を付与
    webhookSecretParam.grantRead(webhookHandler);

    // Lambda関数にFirehoseへの書き込み権限を付与
    webhookHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["firehose:PutRecord", "firehose:PutRecordBatch"],
        resources: [deliveryStream.attrArn],
      }),
    );

    // Webhooksリソースを作成
    const webhooks = api.root.addResource("webhooks");

    // Lambda統合を作成 - GitHubのWebhookを処理
    const webhookIntegration = new apigateway.LambdaIntegration(webhookHandler);

    // POSTメソッドを追加
    webhooks.addMethod("POST", webhookIntegration, {
      requestParameters: {
        "method.request.header.X-GitHub-Event": true,
        "method.request.header.X-GitHub-Delivery": true,
        "method.request.header.X-Hub-Signature-256": true,
      },
      methodResponses: [
        {
          statusCode: "200",
          responseModels: {
            "application/json": apigateway.Model.EMPTY_MODEL,
          },
        },
        {
          statusCode: "400",
          responseModels: {
            "application/json": apigateway.Model.ERROR_MODEL,
          },
        },
        {
          statusCode: "401",
          responseModels: {
            "application/json": apigateway.Model.ERROR_MODEL,
          },
        },
        {
          statusCode: "500",
          responseModels: {
            "application/json": apigateway.Model.ERROR_MODEL,
          },
        },
      ],
    });

    // 出力値
    new CfnOutput(this, "WebhookApiUrl", {
      value: `${api.url}webhooks`,
      description: "GitHub Webhookを設定するためのURL",
    });

    new CfnOutput(this, "WebhookDataBucketName", {
      value: dataBucket.bucketName,
      description: "GitHubのWebhookデータが保存されるS3バケット",
    });

    new CfnOutput(this, "FirehoseDeliveryStreamName", {
      value: deliveryStream.ref,
      description: "Webhook データを処理するKinesis Data Firehoseストリーム",
    });
  }
}

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

const stack = new GitHubActivityMetricsStack(
  app,
  "github-activity-metrics-aws-dev",
  {
    env: devEnv,
  },
);

// CDK Nagのセキュリティチェックをアプリケーションに適用
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// 特定の警告を抑制する場合は以下のように設定
NagSuppressions.addStackSuppressions(
  stack,
  [
    {
      id: "AwsSolutions-IAM4",
      reason: "マネージドポリシーはプロトタイプ段階では許容します",
    },
    {
      id: "AwsSolutions-IAM5",
      reason: "Firehoseサービスロールは限定的な権限を持ちます",
    },
    {
      id: "AwsSolutions-L1",
      reason: "デモ用のLambda関数はインラインコードを使用しています",
    },
    {
      id: "AwsSolutions-APIG2",
      reason:
        "GitHubのWebhookはカスタム認証が必要で、リクエスト検証は別途Lambda統合で実装しています",
    },
    {
      id: "AwsSolutions-APIG4",
      reason:
        "GitHubのWebhookはカスタム認証が必要で、リクエスト検証は別途Lambda統合で実装しています",
    },
    {
      id: "AwsSolutions-COG4",
      reason:
        "GitHubのWebhookではCognitoユーザープールの代わりにカスタムのLambda統合を使用しています",
    },
  ],
  true,
);

app.synth();
