import { RemovalPolicy } from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2_integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { EnvName } from './envName';

export interface ApiProps {
  /**
   * Lambda function for processing GitHub webhooks
   */
  webhookHandler: lambda.NodejsFunction;
  /**
   * Environment name (e.g., dev, prod)
   */
  envName: EnvName;
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

    const removalPolicy =
      props.envName === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const autoDeleteObjects = props.envName === 'dev';

    // Create access log bucket and log group for API Gateway
    const apiGatewayAccessLogsBucket = new s3.Bucket(
      this,
      'ApiGatewayAccessLogsBucket',
      {
        removalPolicy,
        autoDeleteObjects,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
      },
    );

    // CDK Nag suppression settings for access log bucket
    NagSuppressions.addResourceSuppressions(apiGatewayAccessLogsBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'Access logs are not enabled for the access logs bucket',
      },
    ]);

    // HTTP API Gateway (for GitHub Webhooks)
    this.api = new apigatewayv2.HttpApi(this, 'GitHubWebhookApi', {
      apiName: 'GitHub Webhook API',
      description: 'API for receiving GitHub webhooks',
      createDefaultStage: false, // Do not create default stage
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigatewayv2.CorsHttpMethod.POST],
        allowHeaders: [
          'Content-Type',
          'X-GitHub-Event',
          'X-GitHub-Delivery',
          'X-Hub-Signature-256',
        ],
      },
    });

    // Create Lambda integration - Process GitHub webhooks
    const webhookIntegration =
      new apigatewayv2_integrations.HttpLambdaIntegration(
        'WebhookIntegration',
        webhookHandler,
      );

    // Add route for webhooks
    this.api.addRoutes({
      path: '/webhooks',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: webhookIntegration,
    });

    const stageName = 'prod';

    // Create explicit stage
    const stage = new apigatewayv2.CfnStage(this, 'V2Stage', {
      apiId: this.api.apiId,
      stageName: stageName,
      autoDeploy: true, // Configure automatic deployment of API changes
      defaultRouteSettings: {
        throttlingBurstLimit: 100,
        throttlingRateLimit: 50,
        detailedMetricsEnabled: true,
      },
    });

    NagSuppressions.addResourceSuppressions(stage, [
      {
        id: 'AwsSolutions-APIG1',
        reason: 'API Gateway stage does not have access logs enabled',
      },
    ]);

    // Store webhook URL with stage name
    this.webhookUrl = `${this.api.apiEndpoint}/${stageName}/webhooks`;
  }
}
