import * as path from "path";
import { Stack, StackProps, CfnOutput, Duration } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import { Api } from "../lib/api";
import { EnvName } from "../lib/envName";
import { Storage } from "../lib/storage";
import { CustomDataApi } from "../lib/custom-data-api";

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

    const timestreamDatabaseName = "metrics";
    const githubWebHookTimestreamTableName = "github_webhook";
    const customDataTimestreamTableName = "custom_data";
    const githubAPIResultTimestreamTableName = "github_api_result";

    // Create storage resources (Timestream database and tables)
    const storage = new Storage(this, "Storage", {
      databaseName: timestreamDatabaseName,
      githubWebHookTableName: githubWebHookTimestreamTableName,
      customDataTableName: customDataTimestreamTableName,
      githubAPIResultTableName: githubAPIResultTimestreamTableName,
    });

    // Reference GitHub Webhook secret from SSM Parameter Store
    const webhookSecretParam =
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        "GitHubWebhookSecret",
        {
          parameterName: "/github/metrics/secret-token",
          version: 1, // Specify a specific version or use the latest if unspecified
        },
      );

    // Create an SNS topic for GitHub activity notifications
    const githubActivityTopic = new sns.Topic(this, "GitHubActivityTopic", {
      displayName: `call-github-api`,
      topicName: `call-github-api`,
      enforceSSL: true,
    });

    // Lambda function - Validates GitHub webhooks and sends data to Timestream
    const webhookHandler = new NodejsFunction(this, "WebhookHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handler",
      entry: path.join(__dirname, "../lambdas/webhook-handler/index.ts"),
      environment: {
        TIMESTREAM_DATABASE_NAME: timestreamDatabaseName,
        TIMESTREAM_TABLE_NAME: githubWebHookTimestreamTableName,
        SNS_TOPIC_ARN: githubActivityTopic.topicArn,
      },
      timeout: Duration.seconds(30),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ["aws-sdk"],
        // Bundle only the required AWS SDK v3 modules
        nodeModules: [
          "@aws-sdk/client-ssm",
          "@aws-sdk/client-timestream-write",
          "@aws-sdk/client-sns",
        ],
      },
    });

    // Grant SSM parameter read permission to the Lambda function
    webhookSecretParam.grantRead(webhookHandler);

    // Grant webhook lambda permission to publish to SNS topic
    githubActivityTopic.grantPublish(webhookHandler);

    // Grant Timestream write permissions to the Lambda function
    this.addTimestreamWritePermissionsToLambda(
      webhookHandler,
      timestreamDatabaseName,
      githubWebHookTimestreamTableName,
    );

    // API Gateway
    const api = new Api(this, "ApiGateway", {
      webhookHandler,
      envName: props.envName,
    });

    // Create Custom Data API handler Lambda function
    const customDataApiHandler = new NodejsFunction(
      this,
      "CustomDataApiHandler",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "handler",
        environment: {
          TIMESTREAM_DATABASE_NAME: timestreamDatabaseName,
          TIMESTREAM_TABLE_NAME: customDataTimestreamTableName,
        },
        entry: path.join(
          __dirname,
          "../lambdas/custom-data-api-handler/index.ts",
        ),
        timeout: Duration.seconds(10),
        memorySize: 128,
        bundling: {
          minify: true,
          sourceMap: true,
          externalModules: ["aws-sdk"],
        },
      },
    );

    // Grant Timestream write permissions to the Custom Data API handler
    this.addTimestreamWritePermissionsToLambda(
      customDataApiHandler,
      timestreamDatabaseName,
      customDataTimestreamTableName,
    );

    // Create Custom Data API with API Key authentication
    const customDataApi = new CustomDataApi(this, "CustomDataApiGateway", {
      handler: customDataApiHandler,
      apiKeyName: `custom-data-api-key-${props.envName}`,
      usagePlanName: `custom-data-api-usage-plan-${props.envName}`,
    });

    // Output values
    new CfnOutput(this, "WebhookApiUrl", {
      value: api.webhookUrl,
      description: "URL for configuring GitHub Webhook",
    });

    new CfnOutput(this, "TimestreamDatabaseName", {
      value: storage.timestreamDatabase.ref,
      description: "Timestream database where GitHub webhook data is stored",
    });

    new CfnOutput(this, "TimestreamTableName", {
      value: storage.githubWebHookTimestreamTable.ref,
      description: "Timestream table where GitHub webhook data is stored",
    });

    new CfnOutput(this, "ActionsTimestreamTableName", {
      value: storage.customDataTimestreamTable.ref,
      description:
        "Timestream table where GitHub Actions custom data is stored",
    });

    // Output Custom Data API URL
    new CfnOutput(this, "CustomDataApiEndpoint", {
      value: customDataApi.apiUrl,
      description: "Custom Data API endpoint",
    });

    // Reference GitHub Webhook secret from SSM Parameter Store
    const githubTokentParam =
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        "GitHubTokenSecret",
        {
          parameterName: "/github/metrics/github-token",
          version: 1, // Specify a specific version or use the latest if unspecified
        },
      );

    // Create a Lambda function that will be triggered by SNS
    const snsHandler = new NodejsFunction(this, "SnsHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handler",
      entry: path.join(__dirname, "../lambdas/sns-handler/index.ts"),
      timeout: Duration.seconds(30),
      memorySize: 128,
      description: "Processes messages from GitHub activity SNS topic",
      environment: {
        TIMESTREAM_DATABASE_NAME: timestreamDatabaseName,
        TIMESTREAM_TABLE_NAME: githubAPIResultTimestreamTableName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ["aws-sdk"],
        // Bundle only the required AWS SDK v3 modules
        nodeModules: [
          "@aws-sdk/client-ssm",
          "@aws-sdk/client-timestream-write",
          "@octokit/rest",
        ],
      },
    });

    // Grant SSM parameter read permission to the Lambda function
    githubTokentParam.grantRead(snsHandler);

    // Grant Timestream write permissions to the SNS handler Lambda function
    this.addTimestreamWritePermissionsToLambda(
      snsHandler,
      timestreamDatabaseName,
      githubAPIResultTimestreamTableName,
    );

    // Subscribe the Lambda function to the SNS topic
    githubActivityTopic.addSubscription(
      new snsSubs.LambdaSubscription(snsHandler),
    );

    // Output the SNS topic ARN
    new CfnOutput(this, "GitHubActivityTopicArn", {
      value: githubActivityTopic.topicArn,
      description: "SNS Topic ARN for GitHub activity notifications",
    });

    // Configure CDK Nag suppressions
    this.setupNagSuppressions();
  }

  /**
   * Add Timestream write permissions to the Lambda function
   * @param lambdaFunction the Lambda function to which permissions will be added
   * @param databaseName Timestream database name
   * @param tableName Timestream table name
   */
  private addTimestreamWritePermissionsToLambda(
    lambdaFunction: NodejsFunction,
    databaseName: string,
    tableName: string,
  ) {
    // Grant Timestream write permissions to the Lambda function
    lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["timestream:WriteRecords", "timestream:DescribeTable"],
        resources: [
          `arn:aws:timestream:${this.region}:${this.account}:database/${databaseName}/table/${tableName}`,
        ],
      }),
    );

    lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["timestream:DescribeDatabase"],
        resources: [
          `arn:aws:timestream:${this.region}:${this.account}:database/${databaseName}`,
        ],
      }),
    );

    lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["timestream:DescribeEndpoints"],
        resources: ["*"],
      }),
    );
  }

  /**
   * Configure CDK Nag warning suppressions
   */
  private setupNagSuppressions() {
    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: "AwsSolutions-IAM4",
          reason: "Managed policies are acceptable during the prototype phase",
        },
        {
          id: "AwsSolutions-L1",
          reason: "Demo Lambda functions use inline code",
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Wildcard permissions are acceptable during the prototype phase",
        },
        {
          id: "AwsSolutions-APIG2",
          reason:
            "GitHub webhooks require custom authentication, request validation is implemented with Lambda integration",
        },
        {
          id: "AwsSolutions-APIG4",
          reason:
            "GitHub webhooks require custom authentication, request validation is implemented with Lambda integration",
        },
        {
          id: "AwsSolutions-COG4",
          reason:
            "GitHub webhooks use custom Lambda integration instead of Cognito user pools",
        },
      ],
      true,
    );
  }
}
