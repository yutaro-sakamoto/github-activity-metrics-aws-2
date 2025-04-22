import * as apigateway from "aws-cdk-lib/aws-apigateway";
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
   * API Gateway REST API
   */
  public readonly api: apigateway.RestApi;

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

    // REST API Gateway (for GitHub Webhooks)
    this.api = new apigateway.RestApi(this, "GitHubWebhookApi", {
      restApiName: "GitHub Webhook API",
      description: "API for receiving GitHub webhooks",
      deployOptions: {
        stageName: "v1",
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        // Enable access logs
        accessLogDestination: new apigateway.LogGroupLogDestination(
          apiGatewayLogGroup,
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
    });

    // Create webhooks resource
    const webhooks = this.api.root.addResource("webhooks");

    // Create Lambda integration - Process GitHub webhooks
    const webhookIntegration = new apigateway.LambdaIntegration(webhookHandler);

    // Add POST method
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

    // Store webhook URL
    this.webhookUrl = `${this.api.url}webhooks`;
  }
}
