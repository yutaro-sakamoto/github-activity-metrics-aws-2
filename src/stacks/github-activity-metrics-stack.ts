import * as path from 'path';
import { Stack, StackProps, CfnOutput, Duration } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { Api } from '../lib/api';
import { CustomDataApi } from '../lib/custom-data-api';
import { EnvName } from '../lib/envName';
import { Storage } from '../lib/storage';

export interface GitHubActivityMetricsStackProps extends StackProps {
  envName: EnvName;
}

export class GitHubActivityMetricsStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: GitHubActivityMetricsStackProps,
  ) {
    super(scope, id, props);

    // Create storage resources (S3 buckets, Glue database, and Athena)
    const storage = new Storage(this, 'Storage', {
      rawDataBucketPrefix: `${props.envName}-github-metrics`,
      consolidatedDataBucketPrefix: `${props.envName}-github-metrics`,
      glueDatabaseName: 'github_metrics_db',
      athenaWorkgroupName: `github-metrics-${props.envName}`,
    });

    // Reference GitHub Webhook secret from SSM Parameter Store
    const webhookSecretParam =
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        'GitHubWebhookSecret',
        {
          parameterName: '/github/metrics/secret-token',
          version: 1, // Specify a specific version or use the latest if unspecified
        },
      );

    // Create an SNS topic for GitHub activity notifications
    const githubActivityTopic = new sns.Topic(this, 'GitHubActivityTopic', {
      displayName: 'call-github-api',
      topicName: 'call-github-api',
      enforceSSL: true,
    });

    // Lambda function - Validates GitHub webhooks and sends data to Timestream
    const webhookHandler = new NodejsFunction(this, 'WebhookHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambdas/webhook-handler/index.ts'),
      environment: {
        RAW_DATA_BUCKET: storage.rawDataBucket.bucketName,
        SNS_TOPIC_ARN: githubActivityTopic.topicArn,
      },
      timeout: Duration.seconds(30),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['aws-sdk'],
        // Bundle only the required AWS SDK v3 modules
        nodeModules: [
          '@aws-sdk/client-ssm',
          '@aws-sdk/client-s3',
          '@aws-sdk/client-sns',
        ],
      },
    });

    // Grant SSM parameter read permission to the Lambda function
    webhookSecretParam.grantRead(webhookHandler);

    // Grant webhook lambda permission to publish to SNS topic
    githubActivityTopic.grantPublish(webhookHandler);

    // Grant S3 write permissions to the Lambda function
    storage.rawDataBucket.grantWrite(webhookHandler);

    // API Gateway
    const api = new Api(this, 'ApiGateway', {
      webhookHandler,
      envName: props.envName,
    });

    // Create Custom Data API handler Lambda function
    const customDataApiHandler = new NodejsFunction(
      this,
      'CustomDataApiHandler',
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'handler',
        environment: {
          RAW_DATA_BUCKET: storage.rawDataBucket.bucketName,
        },
        entry: path.join(
          __dirname,
          '../lambdas/custom-data-api-handler/index.ts',
        ),
        timeout: Duration.seconds(10),
        memorySize: 128,
        bundling: {
          minify: true,
          sourceMap: true,
          externalModules: ['aws-sdk'],
        },
      },
    );

    // Grant S3 write permissions to the Custom Data API handler
    storage.rawDataBucket.grantWrite(customDataApiHandler);

    // Create Custom Data API with API Key authentication
    const customDataApi = new CustomDataApi(this, 'CustomDataApiGateway', {
      handler: customDataApiHandler,
      apiKeyName: `custom-data-api-key-${props.envName}`,
      usagePlanName: `custom-data-api-usage-plan-${props.envName}`,
    });

    // Output values
    new CfnOutput(this, 'WebhookApiUrl', {
      value: api.webhookUrl,
      description: 'URL for configuring GitHub Webhook',
    });

    // Output Custom Data API URL
    new CfnOutput(this, 'CustomDataApiEndpoint', {
      value: customDataApi.apiUrl,
      description: 'Custom Data API endpoint',
    });

    // Reference GitHub Webhook secret from SSM Parameter Store
    const githubTokentParam =
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        'GitHubTokenSecret',
        {
          parameterName: '/github/metrics/github-token',
          version: 1, // Specify a specific version or use the latest if unspecified
        },
      );

    // Create a Lambda function that will be triggered by SNS
    const snsHandler = new NodejsFunction(this, 'SnsHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambdas/sns-handler/index.ts'),
      timeout: Duration.seconds(30),
      memorySize: 128,
      description: 'Processes messages from GitHub activity SNS topic',
      environment: {
        RAW_DATA_BUCKET: storage.rawDataBucket.bucketName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['aws-sdk'],
        // Bundle only the required AWS SDK v3 modules
        nodeModules: [
          '@aws-sdk/client-ssm',
          '@aws-sdk/client-s3',
          '@octokit/rest',
        ],
      },
    });

    // Grant SSM parameter read permission to the Lambda function
    githubTokentParam.grantRead(snsHandler);

    // Grant S3 write permissions to the SNS handler Lambda function
    storage.rawDataBucket.grantWrite(snsHandler);

    // Subscribe the Lambda function to the SNS topic
    githubActivityTopic.addSubscription(
      new snsSubs.LambdaSubscription(snsHandler),
    );

    // Configure CDK Nag suppressions
    this.setupNagSuppressions();
  }


  /**
   * Configure CDK Nag warning suppressions
   */
  private setupNagSuppressions() {
    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'Managed policies are acceptable during the prototype phase',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'Demo Lambda functions use inline code',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Wildcard permissions are acceptable during the prototype phase',
        },
        {
          id: 'AwsSolutions-APIG2',
          reason:
            'GitHub webhooks require custom authentication, request validation is implemented with Lambda integration',
        },
        {
          id: 'AwsSolutions-APIG4',
          reason:
            'GitHub webhooks require custom authentication, request validation is implemented with Lambda integration',
        },
        {
          id: 'AwsSolutions-COG4',
          reason:
            'GitHub webhooks use custom Lambda integration instead of Cognito user pools',
        },
      ],
      true,
    );
  }
}
