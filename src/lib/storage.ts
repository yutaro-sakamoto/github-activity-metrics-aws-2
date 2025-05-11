import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as backup from "aws-cdk-lib/aws-backup";
import { Schedule } from "aws-cdk-lib/aws-events";
import * as timestream from "aws-cdk-lib/aws-timestream";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

export interface StorageProps {
  /**
   * Timestream database name
   */
  databaseName: string;
  /**
   * Timestream table name for webhook events
   */
  githubWebHookTableName: string;
  /**
   * Timestream table name for GitHub Actions custom data
   * @default "github_actions_data"
   */
  customDataTableName: string;
}

export class Storage extends Construct {
  /**
   * Timestream database that stores GitHub webhook data
   */
  public readonly timestreamDatabase: timestream.CfnDatabase;

  /**
   * Timestream table for webhook events
   */
  public readonly githubWebHookTimestreamTable: timestream.CfnTable;

  /**
   * Timestream table for GitHub Actions custom data
   */
  public readonly customDataTimestreamTable: timestream.CfnTable;

  /**
   * AWS Backup Vault for storing backups
   */
  public readonly backupVault: backup.BackupVault;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);

    // Timestream database for GitHub webhook data
    this.timestreamDatabase = new timestream.CfnDatabase(
      this,
      "MetricsDatabase",
      {
        databaseName: props.databaseName,
      },
    );

    // Timestream table for storing GitHub webhook events
    this.githubWebHookTimestreamTable = new timestream.CfnTable(
      this,
      "GitHubWebhookTable",
      {
        databaseName: props.databaseName,
        tableName: props.githubWebHookTableName,
        retentionProperties: {
          memoryStoreRetentionPeriodInHours: "24", // 1 day in memory store
          magneticStoreRetentionPeriodInDays: "365", // 1 year in magnetic store
        },
      },
    );

    // Timestream table for storing GitHub Actions custom data
    this.customDataTimestreamTable = new timestream.CfnTable(
      this,
      "CustomDataTable",
      {
        databaseName: props.databaseName,
        tableName: props.customDataTableName,
        retentionProperties: {
          memoryStoreRetentionPeriodInHours: "24", // 1 day in memory store
          magneticStoreRetentionPeriodInDays: "365", // 1 year in magnetic store
        },
      },
    );

    // Add dependency to ensure the database is created before the tables
    this.githubWebHookTimestreamTable.addDependency(this.timestreamDatabase);
    this.customDataTimestreamTable.addDependency(this.timestreamDatabase);

    // Create AWS Backup Vault to store backups
    this.backupVault = new backup.BackupVault(this, "MetricsBackupVault", {
      backupVaultName: "metrics-backup-vault",
      removalPolicy: RemovalPolicy.RETAIN, // Retain the vault even if the stack is deleted
    });

    // Create AWS Backup Plan
    const backupPlan = new backup.BackupPlan(this, "MetricsBackupPlan", {
      backupPlanName: "metrics-daily-backup",
      backupVault: this.backupVault,
    });

    // Add backup rule - daily backup at 3:00 AM JST (18:00 UTC), 2 weeks retention
    backupPlan.addRule(
      new backup.BackupPlanRule({
        ruleName: "DailyBackup-3AM-JST",
        scheduleExpression: Schedule.cron({
          minute: "0",
          hour: "18", // 18:00 UTC = 3:00 AM JST
          month: "*",
          weekDay: "*",
          year: "*",
        }),
        deleteAfter: Duration.days(14), // 2 weeks retention
      }),
    );

    // Select the Timestream tables as the resources to back up
    backupPlan.addSelection("TimestreamSelection", {
      resources: [
        backup.BackupResource.fromArn(
          this.githubWebHookTimestreamTable.attrArn,
        ),
        backup.BackupResource.fromArn(this.customDataTimestreamTable.attrArn),
      ],
    });

    // CDK Nag suppressions
    NagSuppressions.addResourceSuppressions(
      [
        this.timestreamDatabase,
        this.githubWebHookTimestreamTable,
        this.customDataTimestreamTable,
      ],
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
