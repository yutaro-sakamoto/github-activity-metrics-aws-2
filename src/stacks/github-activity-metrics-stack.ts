import * as path from "path";
import { Stack, StackProps, CfnOutput, Duration } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

import { Api } from "../lib/api";
import { Storage } from "../lib/storage";

export class GitHubActivityMetricsStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Create storage resources (Timestream database and table)
    const storage = new Storage(this, "Storage");

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
        TIMESTREAM_DATABASE_NAME: storage.timestreamDatabase.ref,
        TIMESTREAM_TABLE_NAME: storage.timestreamTable.ref,
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
    webhookHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "timestream:WriteRecords",
          "timestream:DescribeTable",
          "timestream:DescribeEndpoints",
        ],
        resources: [
          `arn:aws:timestream:${this.region}:${this.account}:database/${storage.timestreamDatabase.ref}/table/${storage.timestreamTable.ref}`,
        ],
      }),
    );

    // API Gateway
    const api = new Api(this, "ApiGateway", {
      webhookHandler,
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
