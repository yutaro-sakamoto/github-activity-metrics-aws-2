import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { GitHubActivityMetricsStack } from "../src/stacks/github-activity-metrics-stack";

test("Snapshot", () => {
  const app = new App();
  const stack = new GitHubActivityMetricsStack(app, "test", {
    env: {
      account: "123456789012",
      region: "ap-northeast-1",
    },
  });

  const template = Template.fromStack(stack);
  expect(template.toJSON()).toMatchSnapshot();
});
