import { App, Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { GitHubActivityMetricsStack } from "./stacks/github-activity-metrics-stack";

// Configure deployment environment - Get environment information from CDK CLI
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// Initialize CDK application
const app = new App();

// Create GitHub Activity Metrics stack
new GitHubActivityMetricsStack(app, "github-activity-metrics-aws-dev", {
  env: devEnv,
});

// Apply CDK Nag security checks to the application
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Synthesize the application
app.synth();
