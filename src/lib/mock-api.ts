import { Construct } from "constructs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { CfnOutput } from "aws-cdk-lib";
import * as aws_logs from "aws-cdk-lib/aws-logs";

export interface MockApiProps {
  /**
   * Lambda handler to process requests
   */
  handler: lambda.Function;

  /**
   * Name of API key
   */
  apiKeyName: string;

  /**
   * API usage plan name
   */
  usagePlanName: string;
}

export class MockApi extends Construct {
  /**
   * API Gateway REST API
   */
  public readonly api: apigateway.RestApi;

  /**
   * API Key for authentication
   */
  public readonly apiKey: apigateway.ApiKey;

  /**
   * Usage plan for the API
   */
  public readonly usagePlan: apigateway.UsagePlan;

  /**
   * API endpoint URL
   */
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: MockApiProps) {
    super(scope, id);

    // Create REST API
    this.api = new apigateway.RestApi(this, "RestApi", {
      restApiName: "Mock API",
      description: "Mock API that always returns successful response",
      deployOptions: {
        stageName: "prod",
        metricsEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new aws_logs.LogGroup(this, "MockApiAccessLogs", {
            retention: aws_logs.RetentionDays.ONE_MONTH,
          }),
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    // Create API Key
    this.apiKey = new apigateway.ApiKey(this, "ApiKey", {
      apiKeyName: props.apiKeyName,
      enabled: true,
    });

    // Create usage plan
    this.usagePlan = new apigateway.UsagePlan(this, "UsagePlan", {
      name: props.usagePlanName,
      apiStages: [
        {
          api: this.api,
          stage: this.api.deploymentStage,
        },
      ],
      throttle: {
        rateLimit: 10,
        burstLimit: 20,
      },
      quota: {
        limit: 1000,
        period: apigateway.Period.DAY,
      },
    });

    // Associate API key with usage plan
    this.usagePlan.addApiKey(this.apiKey);

    // Create a /data resource
    const data = this.api.root.addResource("data");

    // Add GET method
    data.addMethod("GET", new apigateway.LambdaIntegration(props.handler), {
      apiKeyRequired: true, // API Key required for this method
    });

    // Create a /status resource
    const status = this.api.root.addResource("status");

    // Add GET method
    status.addMethod("GET", new apigateway.LambdaIntegration(props.handler), {
      apiKeyRequired: true, // API Key required for this method
    });

    // Output API URL
    this.apiUrl = this.api.url;

    new CfnOutput(this, "MockApiUrl", {
      value: this.api.url,
      description: "URL for the Mock API",
    });

    new CfnOutput(this, "MockApiKeyId", {
      value: this.apiKey.keyId,
      description: "Mock API Key ID",
    });
  }
}
