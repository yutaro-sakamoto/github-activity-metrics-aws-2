import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EnvName } from '../src/lib/envName';
import { GitHubActivityMetricsStack } from '../src/stacks/github-activity-metrics-stack';

const envNames: EnvName[] = ['prod', 'dev'];

envNames.forEach((envName) => {
  const app = new App();
  const stack = new GitHubActivityMetricsStack(app, 'test', {
    env: {
      account: '123456789012',
      region: 'ap-northeast-1',
    },
    envName,
  });

  const template = Template.fromStack(stack);

  test('Snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });

  describe('S3 Bucket Public Access Tests', () => {
    test('All S3 buckets should have block public access enabled', () => {
      const bucketResources = template.findResources('AWS::S3::Bucket');
      if (Object.keys(bucketResources).length > 0) {
        Object.entries(bucketResources).forEach(([_logicalId, resource]) => {
          const bucketProps = resource.Properties;

          expect(bucketProps.PublicAccessBlockConfiguration).toBeDefined();

          const publicAccessBlock = bucketProps.PublicAccessBlockConfiguration;
          expect(publicAccessBlock.BlockPublicAcls).toBe(true);
          expect(publicAccessBlock.BlockPublicPolicy).toBe(true);
          expect(publicAccessBlock.IgnorePublicAcls).toBe(true);
          expect(publicAccessBlock.RestrictPublicBuckets).toBe(true);
        });

        expect(Object.keys(bucketResources).length).toBeGreaterThan(0);
      }
    });
  });
});
