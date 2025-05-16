import { awscdk } from 'projen';
const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: '2.1.0',
  defaultReleaseBranch: 'main',
  name: 'github-activity-metrics-aws',
  projenrcTs: true,

  deps: [
    'cdk-nag',
    '@aws-sdk/client-ssm',
    '@octokit/webhooks',
    '@octokit/rest',
    '@aws-sdk/client-timestream-write',
    '@aws-sdk/client-sns',
    'ip-range-check',
    'aws-lambda',
  ],
  // description: undefined,  /* The description is just a string that helps people understand the purpose of the package. */
  // devDeps: [],             /* Build dependencies for this module. */
  // packageName: undefined,  /* The "name" in package.json. */
});

project.gitignore.addPatterns('docs/');

// remove default workflow files
project.tryRemoveFile('.github/workflows/build.yml');
project.tryRemoveFile('.github/workflows/pull-request-lint.yml');
project.tryRemoveFile('.github/workflows/upgrade.yml');

project.synth();