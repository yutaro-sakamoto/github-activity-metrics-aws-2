import { awscdk } from 'projen';
const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: '2.1.0',
  defaultReleaseBranch: 'main',
  name: 'github-activity-metrics-aws',
  projenrcTs: true,

  deps: [
    'cdk-nag',
    '@aws-sdk/client-ssm',
    '@aws-sdk/client-firehose',
    '@octokit/webhooks',
  ],
  // description: undefined,  /* The description is just a string that helps people understand the purpose of the package. */
  // devDeps: [],             /* Build dependencies for this module. */
  // packageName: undefined,  /* The "name" in package.json. */
});
project.synth();