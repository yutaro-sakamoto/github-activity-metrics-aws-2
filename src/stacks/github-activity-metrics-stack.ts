import { Stack, StackProps, CfnOutput, Duration } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "path";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";

import { Storage } from "../lib/storage";
import { Api } from "../lib/api";

export class GitHubActivityMetricsStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // ストレージリソース（S3バケット、Kinesis Firehose）の作成
    const storage = new Storage(this, "Storage");

    // SSMパラメータからGitHub Webhookのシークレットを参照
    const webhookSecretParam =
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        "GitHubWebhookSecret",
        {
          parameterName: "/github/metrics/secret-token",
          version: 1, // 特定のバージョンを指定するか、未指定で最新を使用
        },
      );

    // Lambda関数 - GitHubのWebhookを検証して、Firehoseにデータを送信する
    const webhookHandler = new NodejsFunction(this, "WebhookHandler", {
      runtime: lambda.Runtime.NODEJS_18_X,
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
        // AWS SDK v3は必要なものだけをバンドルする
        nodeModules: ["@aws-sdk/client-ssm", "@aws-sdk/client-firehose"],
      },
    });

    // Lambda関数にSSMパラメータ読み取り権限を付与
    webhookSecretParam.grantRead(webhookHandler);

    // Lambda関数にFirehoseへの書き込み権限を付与
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

    // 出力値
    new CfnOutput(this, "WebhookApiUrl", {
      value: api.webhookUrl,
      description: "GitHub Webhookを設定するためのURL",
    });

    new CfnOutput(this, "WebhookDataBucketName", {
      value: storage.dataBucket.bucketName,
      description: "GitHubのWebhookデータが保存されるS3バケット",
    });

    new CfnOutput(this, "FirehoseDeliveryStreamName", {
      value: storage.deliveryStream.ref,
      description: "Webhook データを処理するKinesis Data Firehoseストリーム",
    });

    // CDK Nag抑制の設定
    this.setupNagSuppressions();
  }

  /**
   * CDK Nagの警告抑制を設定
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
            "Firehoseサービスロールと Lambda ロールは限定的な権限を持ちます",
        },
      ],
      true,
    );

    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: "AwsSolutions-IAM4",
          reason: "マネージドポリシーはプロトタイプ段階では許容します",
        },
        {
          id: "AwsSolutions-L1",
          reason: "デモ用のLambda関数はインラインコードを使用しています",
        },
        {
          id: "AwsSolutions-APIG2",
          reason:
            "GitHubのWebhookはカスタム認証が必要で、リクエスト検証は別途Lambda統合で実装しています",
        },
        {
          id: "AwsSolutions-APIG4",
          reason:
            "GitHubのWebhookはカスタム認証が必要で、リクエスト検証は別途Lambda統合で実装しています",
        },
        {
          id: "AwsSolutions-COG4",
          reason:
            "GitHubのWebhookではCognitoユーザープールの代わりにカスタムのLambda統合を使用しています",
        },
      ],
      true,
    );
  }
}
