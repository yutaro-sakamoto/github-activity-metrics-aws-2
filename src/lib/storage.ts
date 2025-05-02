import * as timestream from "aws-cdk-lib/aws-timestream";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

export interface StorageProps {
  /**
   * Timestream database name
   */
  databaseName: string;
  /**
   * Timestream table name
   */
  tableName: string;
}

export class Storage extends Construct {
  /**
   * Timestream database that stores GitHub webhook data
   */
  public readonly timestreamDatabase: timestream.CfnDatabase;

  /**
   * Timestream table
   */
  public readonly timestreamTable: timestream.CfnTable;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);

    // Timestream database for GitHub webhook data
    this.timestreamDatabase = new timestream.CfnDatabase(
      this,
      "GitHubWebhookDatabase",
      {
        databaseName: props.databaseName,
      },
    );

    // Timestream table for storing GitHub webhook events
    this.timestreamTable = new timestream.CfnTable(this, "GitHubWebhookTable", {
      databaseName: props.databaseName,
      tableName: props.tableName,
      retentionProperties: {
        memoryStoreRetentionPeriodInHours: "24", // 1 day in memory store
        magneticStoreRetentionPeriodInDays: "365", // 1 year in magnetic store
      },
    });

    // Add dependency to ensure the database is created before the table
    this.timestreamTable.addDependency(this.timestreamDatabase);

    // CDK Nag suppressions
    NagSuppressions.addResourceSuppressions(
      [this.timestreamDatabase, this.timestreamTable],
      [
        {
          id: "AwsSolutions-IAM4",
          reason: "Managed policies are acceptable during the prototype phase",
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Wildcard permissions are acceptable during the prototype phase",
        },
      ],
    );
  }
}
