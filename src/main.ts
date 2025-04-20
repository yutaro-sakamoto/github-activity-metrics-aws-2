import {
  App,
  Stack,
  StackProps,
  RemovalPolicy,
  Duration,
  CfnOutput,
} from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export class GitHubActivityMetricsStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // S3バケット - GitHub Webhookデータの保存先
    const dataBucket = new s3.Bucket(this, "GitHubWebhookDataBucket", {
      removalPolicy: RemovalPolicy.RETAIN, // 本番環境ではデータを保持
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

    // API GatewayからFirehoseへのプロキシ用のIAMロール
    const apiGatewayRole = new iam.Role(this, "ApiGatewayFirehoseRole", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    });

    // API GatewayにFirehoseへの書き込み権限を付与
    apiGatewayRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["firehose:PutRecord", "firehose:PutRecordBatch"],
        resources: [deliveryStream.attrArn],
      }),
    );

    // REST API Gateway (GitHub Webhook用)
    const api = new apigateway.RestApi(this, "GitHubWebhookApi", {
      restApiName: "GitHub Webhook API",
      description: "API for receiving GitHub webhooks",
      deployOptions: {
        stageName: "v1",
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
      },
    });

    // Lambda Authorizer - GitHubからのWebhookを認証
    const webhookAuthorizer = new lambda.Function(this, "WebhookAuthorizer", {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(`
        // GitHubからのWebhook認証Lambda
        exports.handler = async (event) => {
          console.log('Auth Event:', JSON.stringify(event));
          
          try {
            // GitHub Webhookのシークレットトークンを検証
            // 実際の実装では環境変数や AWS Secrets Manager からシークレットを取得
            const expectedSecret = process.env.GITHUB_WEBHOOK_SECRET;
            
            // X-Hub-Signature ヘッダーからの署名を検証
            const signature = event.headers['X-Hub-Signature-256'] || event.headers['x-hub-signature-256'];
            
            if (!signature) {
              console.log('Missing signature header');
              return generatePolicy('user', 'Deny', event.methodArn);
            }
            
            // 実際の実装では、リクエストボディとシークレットを使用して
            // HMAC SHA-256 署名を計算し、GitHubから送信された署名と比較します
            // このサンプルでは簡略化のため、特定の署名パターンをチェック
            const isValid = signature.startsWith('sha256=') && signature.length > 50;
            
            if (!isValid) {
              console.log('Invalid signature');
              return generatePolicy('user', 'Deny', event.methodArn);
            }
            
            // 検証OK
            return generatePolicy('user', 'Allow', event.methodArn);
          } catch (error) {
            console.error('Authorization error:', error);
            return generatePolicy('user', 'Deny', event.methodArn);
          }
        };
        
        // IAM ポリシードキュメントの生成ヘルパー関数
        function generatePolicy(principalId, effect, resource) {
          const authResponse = {
            principalId: principalId,
            policyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  Action: 'execute-api:Invoke',
                  Effect: effect,
                  Resource: resource
                }
              ]
            },
            // オプション: コンテキスト情報をLambda統合に渡す
            context: {
              source: 'github-webhook',
              timestamp: new Date().toISOString()
            }
          };
          
          return authResponse;
        }
      `),
      environment: {
        // 本番環境では AWS Secrets Manager などで管理することを推奨
        GITHUB_WEBHOOK_SECRET: "your-github-webhook-secret-here",
      },
      timeout: Duration.seconds(10),
    });

    // API Gateway RequestAuthorizerを作成
    const apiAuthorizer = new apigateway.RequestAuthorizer(
      this,
      "WebhookRequestAuthorizer",
      {
        handler: webhookAuthorizer,
        identitySources: [
          "method.request.header.X-Hub-Signature-256",
          "method.request.header.X-GitHub-Event",
          "method.request.header.X-GitHub-Delivery",
        ],
        resultsCacheTtl: Duration.seconds(0), // キャッシュなし（セキュリティのため）
      },
    );

    // Webhooksリソースを作成
    const webhooks = api.root.addResource("webhooks");

    // AWS統合を使用してAPI GatewayとKinesis Data Firehoseを直接連携
    const firehoseIntegration = new apigateway.AwsIntegration({
      service: "firehose",
      action: "PutRecord",
      options: {
        credentialsRole: apiGatewayRole,
        requestTemplates: {
          "application/json": `{
            "DeliveryStreamName": "${deliveryStream.ref}",
            "Record": {
              "Data": "$util.base64Encode($input.body)"
            }
          }`,
        },
        integrationResponses: [
          {
            statusCode: "200",
            responseTemplates: {
              "application/json": `{
                "message": "Webhook received successfully",
                "deliveryStreamName": "${deliveryStream.ref}"
              }`,
            },
          },
          {
            selectionPattern: "4\\d{2}",
            statusCode: "400",
            responseTemplates: {
              "application/json": '{"message": "Bad request"}',
            },
          },
          {
            selectionPattern: "5\\d{2}",
            statusCode: "500",
            responseTemplates: {
              "application/json": '{"message": "Internal server error"}',
            },
          },
        ],
      },
    });

    // POSTメソッドを追加して、Lambda AuthorizerとFirehose統合を設定
    webhooks.addMethod("POST", firehoseIntegration, {
      authorizer: apiAuthorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      requestParameters: {
        "method.request.header.X-Hub-Signature-256": true,
        "method.request.header.X-GitHub-Event": true,
        "method.request.header.X-GitHub-Delivery": true,
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

new GitHubActivityMetricsStack(app, "github-activity-metrics-aws-dev", {
  env: devEnv,
});
// new GitHubActivityMetricsStack(app, 'github-activity-metrics-aws-prod', { env: prodEnv });

app.synth();
