import * as path from 'path';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface StorageProps {
  /**
   * S3 bucket prefix for raw data bucket
   */
  rawDataBucketPrefix: string;
  /**
   * S3 bucket prefix for consolidated data bucket
   */
  consolidatedDataBucketPrefix: string;
  /**
   * Glue database name
   */
  glueDatabaseName: string;
  /**
   * Athena workgroup name
   */
  athenaWorkgroupName: string;
}

export class Storage extends Construct {
  /**
   * S3 bucket for raw GitHub webhook data (Bucket A)
   */
  public readonly rawDataBucket: s3.Bucket;

  /**
   * S3 bucket for consolidated data (Bucket B)
   */
  public readonly consolidatedDataBucket: s3.Bucket;

  /**
   * Glue database for Athena queries
   */
  public readonly glueDatabase: glue.CfnDatabase;

  /**
   * Athena workgroup
   */
  public readonly athenaWorkgroup: athena.CfnWorkGroup;

  /**
   * Lambda function for daily consolidation
   */
  public readonly consolidationLambda: NodejsFunction;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);

    // S3 bucket for raw webhook data (Bucket A)
    this.rawDataBucket = new s3.Bucket(this, 'RawDataBucket', {
      bucketName: `${props.rawDataBucketPrefix}-raw-webhook-data`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      lifecycleRules: [
        {
          id: 'DeleteOldRawData',
          enabled: true,
          expiration: Duration.days(7), // Keep raw data for 7 days
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // S3 bucket for consolidated data (Bucket B)
    this.consolidatedDataBucket = new s3.Bucket(this, 'ConsolidatedDataBucket', {
      bucketName: `${props.consolidatedDataBucketPrefix}-consolidated-webhook-data`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      lifecycleRules: [
        {
          id: 'TransitionToGlacier',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: Duration.days(90),
            },
          ],
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Glue database for Athena
    this.glueDatabase = new glue.CfnDatabase(this, 'GlueDatabase', {
      catalogId: Stack.of(this).account,
      databaseInput: {
        name: props.glueDatabaseName,
        description: 'Database for GitHub webhook analytics',
      },
    });

    // Athena workgroup
    const athenaResultsBucket = new s3.Bucket(this, 'AthenaResultsBucket', {
      bucketName: `${props.athenaWorkgroupName}-athena-results`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'DeleteOldResults',
          enabled: true,
          expiration: Duration.days(30),
        },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.athenaWorkgroup = new athena.CfnWorkGroup(this, 'AthenaWorkgroup', {
      name: props.athenaWorkgroupName,
      workGroupConfiguration: {
        resultConfiguration: {
          outputLocation: `s3://${athenaResultsBucket.bucketName}/`,
          encryptionConfiguration: {
            encryptionOption: 'SSE_S3',
          },
        },
        enforceWorkGroupConfiguration: true,
      },
    });

    // Lambda function for daily data consolidation
    this.consolidationLambda = new NodejsFunction(this, 'ConsolidationLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambdas/consolidation-handler/index.ts'),
      environment: {
        RAW_DATA_BUCKET: this.rawDataBucket.bucketName,
        CONSOLIDATED_DATA_BUCKET: this.consolidatedDataBucket.bucketName,
        GLUE_DATABASE: props.glueDatabaseName,
      },
      timeout: Duration.minutes(15),
      memorySize: 3008,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['aws-sdk'],
        nodeModules: [
          '@aws-sdk/client-s3',
          '@aws-sdk/client-glue',
        ],
      },
    });

    // Grant Lambda permissions
    this.rawDataBucket.grantRead(this.consolidationLambda);
    this.consolidatedDataBucket.grantWrite(this.consolidationLambda);

    // Add Glue permissions to Lambda
    this.consolidationLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'glue:CreateTable',
          'glue:UpdateTable',
          'glue:GetTable',
          'glue:GetDatabase',
          'glue:CreatePartition',
          'glue:UpdatePartition',
          'glue:GetPartition',
          'glue:BatchCreatePartition',
        ],
        resources: [
          `arn:aws:glue:${Stack.of(this).region}:${Stack.of(this).account}:catalog`,
          `arn:aws:glue:${Stack.of(this).region}:${Stack.of(this).account}:database/${props.glueDatabaseName}`,
          `arn:aws:glue:${Stack.of(this).region}:${Stack.of(this).account}:table/${props.glueDatabaseName}/*`,
        ],
      }),
    );

    // Schedule daily consolidation at 1:00 AM UTC
    const consolidationRule = new events.Rule(this, 'ConsolidationSchedule', {
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '1',
        day: '*',
        month: '*',
        year: '*',
      }),
    });

    consolidationRule.addTarget(new targets.LambdaFunction(this.consolidationLambda));

    // CDK Nag suppressions
    NagSuppressions.addResourceSuppressions(
      [
        this.rawDataBucket,
        this.consolidatedDataBucket,
        athenaResultsBucket,
        this.consolidationLambda,
      ],
      [
        {
          id: 'AwsSolutions-S1',
          reason: 'Server access logging not required for prototype',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'Managed policies are acceptable during the prototype phase',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Wildcard permissions are acceptable during the prototype phase',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'Latest runtime version check can be ignored for prototype',
        },
      ],
    );
  }
}