import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigatewayv2_integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

export interface ApiProps {
  /**
   * Lambda function for processing GitHub webhooks
   */
  webhookHandler: lambda.NodejsFunction;
}

export class Api extends Construct {
  /**
   * API Gateway HTTP API
   */
  public readonly api: apigatewayv2.HttpApi;

  /**
   * Complete URL for the webhook endpoint
   */
  public readonly webhookUrl: string;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    const { webhookHandler } = props;

    // Create access log bucket and log group for API Gateway
    const apiGatewayAccessLogsBucket = new s3.Bucket(
      this,
      "ApiGatewayAccessLogsBucket",
      {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
      },
    );

    // CDK Nag suppression settings for access log bucket
    NagSuppressions.addResourceSuppressions(apiGatewayAccessLogsBucket, [
      {
        id: "AwsSolutions-S1",
        reason: "Access logs are not enabled for the access logs bucket",
      },
    ]);

    // CloudWatch log group for API Gateway access logs
    const apiGatewayLogGroup = new logs.LogGroup(this, "ApiGatewayAccessLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
    });

    // HTTP API Gateway (for GitHub Webhooks)
    this.api = new apigatewayv2.HttpApi(this, "GitHubWebhookApi", {
      apiName: "GitHub Webhook API",
      description: "API for receiving GitHub webhooks",
      createDefaultStage: false, // デフォルトステージを作成しない
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigatewayv2.CorsHttpMethod.POST],
        allowHeaders: [
          "Content-Type",
          "X-GitHub-Event",
          "X-GitHub-Delivery",
          "X-Hub-Signature-256",
        ],
      },
    });

    // Create Lambda integration - Process GitHub webhooks
    const webhookIntegration =
      new apigatewayv2_integrations.HttpLambdaIntegration(
        "WebhookIntegration",
        webhookHandler,
      );

    // Add route for webhooks
    this.api.addRoutes({
      path: "/webhooks",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: webhookIntegration,
    });

    // 明示的なステージを作成
    new apigatewayv2.CfnStage(this, "V2Stage", {
      apiId: this.api.apiId,
      stageName: "v2",
      autoDeploy: true, // APIの変更が自動的にデプロイされるよう設定
      accessLogSettings: {
        destinationArn: apiGatewayLogGroup.logGroupArn,
        format: JSON.stringify({
          requestId: "$context.requestId",
          ip: "$context.identity.sourceIp",
          caller: "$context.identity.caller",
          user: "$context.identity.user",
          requestTime: "$context.requestTime",
          httpMethod: "$context.httpMethod",
          resourcePath: "$context.resourcePath",
          status: "$context.status",
          protocol: "$context.protocol",
          responseLength: "$context.responseLength",
        }),
      },
      defaultRouteSettings: {
        throttlingBurstLimit: 100,
        throttlingRateLimit: 50,
        detailedMetricsEnabled: true,
      },
    });

    // Store webhook URL with stage name
    this.webhookUrl = `${this.api.apiEndpoint}/v2/webhooks`;
  }
}
