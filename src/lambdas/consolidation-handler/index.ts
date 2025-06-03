import { GlueClient, CreateTableCommand, UpdateTableCommand, GetTableCommand, BatchCreatePartitionCommand } from '@aws-sdk/client-glue';
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client();
const glueClient = new GlueClient();

interface ConsolidationEvent {
  consolidateForDate?: string; // Optional date in YYYY-MM-DD format
}

export const handler = async (event: ConsolidationEvent) => {
  console.log('Daily consolidation triggered');

  const rawBucket = process.env.RAW_DATA_BUCKET!;
  const consolidatedBucket = process.env.CONSOLIDATED_DATA_BUCKET!;
  const glueDatabase = process.env.GLUE_DATABASE!;

  // Determine date to consolidate
  const dateToConsolidate = event.consolidateForDate
    ? new Date(event.consolidateForDate)
    : new Date(Date.now() - 24 * 60 * 60 * 1000); // Yesterday

  const year = dateToConsolidate.getUTCFullYear();
  const month = String(dateToConsolidate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dateToConsolidate.getUTCDate()).padStart(2, '0');

  console.log(`Consolidating data for ${year}-${month}-${day}`);

  try {
    // Process each event type
    const eventTypes = ['push', 'pull_request', 'issues', 'workflow_run', 'pull_request_review'];
    const customDataPrefix = 'custom_data';
    const githubApiResultPrefix = 'github_api_result';

    // Include all data types
    const allPrefixes = [
      ...eventTypes.map(type => `event_type=${type}`),
      customDataPrefix,
      githubApiResultPrefix,
    ];

    for (const prefix of allPrefixes) {
      await consolidateDataForPrefix(
        rawBucket,
        consolidatedBucket,
        prefix,
        year,
        month,
        day,
      );
    }

    // Update Glue catalog with new partitions
    await updateGlueCatalog(glueDatabase, consolidatedBucket, year, month, day);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Consolidation completed for ${year}-${month}-${day}`,
      }),
    };
  } catch (error) {
    console.error('Error during consolidation:', error);
    throw error;
  }
};

async function consolidateDataForPrefix(
  rawBucket: string,
  consolidatedBucket: string,
  prefix: string,
  year: number,
  month: string,
  day: string,
) {
  console.log(`Consolidating ${prefix} for ${year}-${month}-${day}`);

  // List all objects for the specific date
  const listParams = {
    Bucket: rawBucket,
    Prefix: `${prefix}/year=${year}/month=${month}/day=${day}/`,
  };

  const objects: any[] = [];
  let continuationToken: string | undefined;

  do {
    const listCommand = new ListObjectsV2Command({
      ...listParams,
      ContinuationToken: continuationToken,
    });
    const listResponse = await s3Client.send(listCommand);

    if (listResponse.Contents) {
      objects.push(...listResponse.Contents);
    }

    continuationToken = listResponse.NextContinuationToken;
  } while (continuationToken);

  if (objects.length === 0) {
    console.log(`No objects found for ${prefix} on ${year}-${month}-${day}`);
    return;
  }

  console.log(`Found ${objects.length} objects to consolidate`);

  // Read and consolidate all objects
  const consolidatedData: any[] = [];

  for (const obj of objects) {
    if (obj.Key) {
      const getCommand = new GetObjectCommand({
        Bucket: rawBucket,
        Key: obj.Key,
      });

      const response = await s3Client.send(getCommand);
      const content = await response.Body?.transformToString();

      if (content) {
        try {
          const jsonData = JSON.parse(content);
          consolidatedData.push(jsonData);
        } catch (error) {
          console.error(`Failed to parse JSON from ${obj.Key}:`, error);
        }
      }
    }
  }

  if (consolidatedData.length === 0) {
    console.log(`No valid data to consolidate for ${prefix} on ${year}-${month}-${day}`);
    return;
  }

  // Write consolidated data as newline-delimited JSON
  const consolidatedKey = `${prefix}/year=${year}/month=${month}/day=${day}/consolidated_${year}${month}${day}.json`;
  const consolidatedContent = consolidatedData.map(item => JSON.stringify(item)).join('\n');

  const putCommand = new PutObjectCommand({
    Bucket: consolidatedBucket,
    Key: consolidatedKey,
    Body: consolidatedContent,
    ContentType: 'application/x-ndjson',
  });

  await s3Client.send(putCommand);
  console.log(`Successfully consolidated ${consolidatedData.length} records to ${consolidatedKey}`);

  // Delete original files after successful consolidation
  const deleteParams = {
    Bucket: rawBucket,
    Delete: {
      Objects: objects.filter(obj => obj.Key).map(obj => ({ Key: obj.Key! })),
    },
  };

  if (deleteParams.Delete.Objects.length > 0) {
    const deleteCommand = new DeleteObjectsCommand(deleteParams);
    await s3Client.send(deleteCommand);
    console.log(`Deleted ${deleteParams.Delete.Objects.length} original files`);
  }
}

async function updateGlueCatalog(
  glueDatabase: string,
  consolidatedBucket: string,
  year: number,
  month: string,
  day: string,
) {
  const tableName = 'github_metrics';

  try {
    // Check if table exists
    const getTableCommand = new GetTableCommand({
      DatabaseName: glueDatabase,
      Name: tableName,
    });

    try {
      await glueClient.send(getTableCommand);
      console.log(`Table ${tableName} already exists`);
    } catch (error: any) {
      if (error.name === 'EntityNotFoundException') {
        // Create table if it doesn't exist
        console.log(`Creating table ${tableName}`);
        await createGlueTable(glueDatabase, tableName, consolidatedBucket);
      } else {
        throw error;
      }
    }

    // Add partition for the consolidated data
    const partitions = [
      {
        Values: [year.toString(), month, day],
        StorageDescriptor: {
          Location: `s3://${consolidatedBucket}/year=${year}/month=${month}/day=${day}/`,
          InputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          OutputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          SerdeInfo: {
            SerializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
          },
        },
      },
    ];

    const createPartitionCommand = new BatchCreatePartitionCommand({
      DatabaseName: glueDatabase,
      TableName: tableName,
      PartitionInputList: partitions,
    });

    try {
      await glueClient.send(createPartitionCommand);
      console.log(`Created partition for ${year}-${month}-${day}`);
    } catch (error: any) {
      if (error.name === 'AlreadyExistsException') {
        console.log(`Partition for ${year}-${month}-${day} already exists`);
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('Error updating Glue catalog:', error);
    throw error;
  }
}

async function createGlueTable(
  glueDatabase: string,
  tableName: string,
  consolidatedBucket: string,
) {
  const createTableCommand = new CreateTableCommand({
    DatabaseName: glueDatabase,
    TableInput: {
      Name: tableName,
      StorageDescriptor: {
        Columns: [
          { Name: 'timestamp', Type: 'string' },
          { Name: 'event_type', Type: 'string' },
          { Name: 'delivery_id', Type: 'string' },
          { Name: 'repository_id', Type: 'bigint' },
          { Name: 'repository_name', Type: 'string' },
          { Name: 'repository_full_name', Type: 'string' },
          { Name: 'organization_id', Type: 'bigint' },
          { Name: 'organization_login', Type: 'string' },
          { Name: 'sender_id', Type: 'bigint' },
          { Name: 'sender_login', Type: 'string' },
          { Name: 'action', Type: 'string' },
          // Event-specific fields
          { Name: 'commits_count', Type: 'bigint' },
          { Name: 'ref', Type: 'string' },
          { Name: 'pr_number', Type: 'bigint' },
          { Name: 'pr_state', Type: 'string' },
          { Name: 'pr_merged', Type: 'boolean' },
          { Name: 'pr_changed_files', Type: 'bigint' },
          { Name: 'pr_additions', Type: 'bigint' },
          { Name: 'pr_deletions', Type: 'bigint' },
          { Name: 'workflow_run_id', Type: 'bigint' },
          { Name: 'workflow_name', Type: 'string' },
          { Name: 'workflow_conclusion', Type: 'string' },
          // Custom data fields
          { Name: 'dimensions', Type: 'map<string,string>' },
          { Name: 'measure_name', Type: 'string' },
          { Name: 'measure_value_type', Type: 'string' },
        ],
        Location: `s3://${consolidatedBucket}/`,
        InputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
        OutputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
        SerdeInfo: {
          SerializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
        },
      },
      PartitionKeys: [
        { Name: 'year', Type: 'string' },
        { Name: 'month', Type: 'string' },
        { Name: 'day', Type: 'string' },
      ],
      TableType: 'EXTERNAL_TABLE',
    },
  });

  await glueClient.send(createTableCommand);
  console.log(`Created table ${tableName}`);
}