import { Construct } from "constructs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as logs from "aws-cdk-lib/aws-logs";
import * as lambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { NagSuppressions } from "cdk-nag";

export interface ApiProps {
  /**
   * GitHubのWebhook処理Lambda
   */
  webhookHandler: lambda.NodejsFunction;
}

export class Api extends Construct {
  /**
   * API Gateway REST API
   */
  public readonly api: apigateway.RestApi;

  /**
   * Webhookエンドポイントの完全なURL
   */
  public readonly webhookUrl: string;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    const { webhookHandler } = props;

    // API Gatewayのアクセスログバケットとロググループを作成
    const apiGatewayAccessLogsBucket = new s3.Bucket(
      this,
      "ApiGatewayAccessLogsBucket",
      {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
      },
    );

    // アクセスログバケットのCDK Nag抑制設定
    NagSuppressions.addResourceSuppressions(apiGatewayAccessLogsBucket, [
      {
        id: "AwsSolutions-S1",
        reason: "アクセスログバケットに対するアクセスログは有効化しない",
      },
    ]);

    // API GatewayアクセスログのためのCloudWatchロググループ
    const apiGatewayLogGroup = new logs.LogGroup(this, "ApiGatewayAccessLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
    });

    // REST API Gateway (GitHub Webhook用)
    this.api = new apigateway.RestApi(this, "GitHubWebhookApi", {
      restApiName: "GitHub Webhook API",
      description: "API for receiving GitHub webhooks",
      deployOptions: {
        stageName: "v1",
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        // アクセスログを有効化
        accessLogDestination: new apigateway.LogGroupLogDestination(
          apiGatewayLogGroup,
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
    });

    // Webhooksリソースを作成
    const webhooks = this.api.root.addResource("webhooks");

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

    // Webhook URLを保存
    this.webhookUrl = `${this.api.url}webhooks`;
  }
}
