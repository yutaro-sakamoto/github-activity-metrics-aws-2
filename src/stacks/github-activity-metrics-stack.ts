import * as path from "path";
import { Stack, StackProps, CfnOutput, Duration } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

import { Api } from "../lib/api";
import { EnvName } from "../lib/envName";
import { Storage } from "../lib/storage";
import { MockApi } from "../lib/mock-api";

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

    const timestreamDatabaseName = "github_webhook_data";
    const timestreamTableName = "github_events";
    const githubActionsTimestreamTableName = "github_actions_data";

    // Create storage resources (Timestream database and tables)
    const storage = new Storage(this, "Storage", {
      databaseName: timestreamDatabaseName,
      tableName: timestreamTableName,
      actionsTableName: githubActionsTimestreamTableName,
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

    // Lambda function - Validates GitHub webhooks and sends data to Timestream
    const webhookHandler = new NodejsFunction(this, "WebhookHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handler",
      entry: path.join(__dirname, "../lambdas/webhook-handler/index.ts"),
      environment: {
        TIMESTREAM_DATABASE_NAME: timestreamDatabaseName,
        TIMESTREAM_TABLE_NAME: timestreamTableName,
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
        ],
      },
    });

    // Grant SSM parameter read permission to the Lambda function
    webhookSecretParam.grantRead(webhookHandler);

    // Grant Timestream write permissions to the Lambda function
    this.addTimestreamWritePermissionsToLambda(
      webhookHandler,
      timestreamDatabaseName,
      timestreamTableName,
    );

    // API Gateway
    const api = new Api(this, "ApiGateway", {
      webhookHandler,
      envName: props.envName,
    });

    // Create Mock API handler Lambda function
    const mockApiHandler = new NodejsFunction(this, "MockApiHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handler",
      environment: {
        TIMESTREAM_DATABASE_NAME: timestreamDatabaseName,
        TIMESTREAM_TABLE_NAME: githubActionsTimestreamTableName,
      },
      entry: path.join(__dirname, "../lambdas/mock-api-handler/index.ts"),
      timeout: Duration.seconds(10),
      memorySize: 128,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ["aws-sdk"],
      },
    });

    // Grant Timestream write permissions to the Mock API handler
    this.addTimestreamWritePermissionsToLambda(
      mockApiHandler,
      timestreamDatabaseName,
      githubActionsTimestreamTableName,
    );

    // Create Mock API with API Key authentication
    const mockApi = new MockApi(this, "MockApiGateway", {
      handler: mockApiHandler,
      apiKeyName: `mock-api-key-${props.envName}`,
      usagePlanName: `mock-api-usage-plan-${props.envName}`,
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
      value: storage.timestreamTable.ref,
      description: "Timestream table where GitHub webhook data is stored",
    });

    new CfnOutput(this, "ActionsTimestreamTableName", {
      value: storage.actionsTimestreamTable.ref,
      description:
        "Timestream table where GitHub Actions custom data is stored",
    });

    // Output Mock API URL
    new CfnOutput(this, "MockApiEndpoint", {
      value: mockApi.apiUrl,
      description: "Mock API endpoint that always returns successful response",
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
