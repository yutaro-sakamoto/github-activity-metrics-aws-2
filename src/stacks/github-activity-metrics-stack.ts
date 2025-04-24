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
import { Analytics } from "../lib/analytics";

export class GitHubActivityMetricsStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Create storage resources (S3 bucket, Kinesis Firehose)
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

    // Lambda function - Validates GitHub webhooks and sends data to Firehose
    const webhookHandler = new NodejsFunction(this, "WebhookHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handler",
      entry: path.join(__dirname, "../lambdas/webhook-handler/index.ts"),
      environment: {
        DELIVERY_STREAM_NAME: storage.deliveryStream.ref,
      },
      timeout: Duration.seconds(30),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ["aws-sdk"],
        // Bundle only the required AWS SDK v3 modules
        nodeModules: ["@aws-sdk/client-ssm", "@aws-sdk/client-firehose"],
      },
    });

    // Grant SSM parameter read permission to the Lambda function
    webhookSecretParam.grantRead(webhookHandler);

    // Grant Firehose write permissions to the Lambda function
    webhookHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["firehose:PutRecord", "firehose:PutRecordBatch"],
        resources: [storage.deliveryStream.attrArn],
      }),
    );

    // API Gateway
    const api = new Api(this, "ApiGateway", {
      webhookHandler,
    });

    // Add Analytics resources for Athena queries
    const analytics = new Analytics(this, "Analytics", {
      dataBucket: storage.dataBucket,
    });

    // Output values
    new CfnOutput(this, "WebhookApiUrl", {
      value: api.webhookUrl,
      description: "URL for configuring GitHub Webhook",
    });

    new CfnOutput(this, "WebhookDataBucketName", {
      value: storage.dataBucket.bucketName,
      description: "S3 bucket where GitHub webhook data is stored",
    });

    new CfnOutput(this, "FirehoseDeliveryStreamName", {
      value: storage.deliveryStream.ref,
      description: "Kinesis Data Firehose stream that processes webhook data",
    });

    // Athena関連の出力
    new CfnOutput(this, "AthenaWorkgroupName", {
      value: analytics.workgroup.ref,
      description: "Athena workgroup for querying GitHub webhook data",
    });

    new CfnOutput(this, "GlueDatabaseName", {
      value: analytics.database.ref,
      description: "Glue database containing GitHub webhook data schema",
    });

    // Configure CDK Nag suppressions
    this.setupNagSuppressions();
  }

  /**
   * Configure CDK Nag warning suppressions
   */
  private setupNagSuppressions() {
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [
        `${this.stackName}/Storage/FirehoseRole/DefaultPolicy/Resource`,
        `${this.stackName}/WebhookHandler/ServiceRole/DefaultPolicy/Resource`,
      ],
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Firehose service role and Lambda role have limited permissions",
        },
      ],
      true,
    );

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
