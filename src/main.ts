import { App, Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { GitHubActivityMetricsStack } from "./stacks/github-activity-metrics-stack";

// デプロイ環境の設定 - CDK CLIから環境情報を取得
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// CDKアプリケーションを初期化
const app = new App();

// GitHub Activity Metricsスタックを作成
new GitHubActivityMetricsStack(app, "github-activity-metrics-aws-dev", {
  env: devEnv,
});

// CDK Nagのセキュリティチェックをアプリケーションに適用
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// アプリケーションの合成
app.synth();
