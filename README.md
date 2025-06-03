> [!CAUTION]
> github-activity-metrics-aws-2 is a new version of [github-activity-metrics-aws](https://github.com/yutaro-sakamoto/github-activity-metrics-aws).



**GitHub Activity Metrics with S3 and Athena**

This project constructs the infrastructure to collect GitHub Webhook data, store it in Amazon S3, and visualize it using Amazon Athena and QuickSight.

![GitHub webhook visualize architecture](asset/github_webhook_visualize_architecture.drawio.png)

## Architecture Overview

The solution uses a two-bucket approach for efficient data storage and querying:

1. **Raw Data Bucket (Bucket A)**: Collects GitHub webhook events in real-time as they arrive. Data is partitioned by event type, year, month, day, and hour for efficient organization.

2. **Consolidated Data Bucket (Bucket B)**: Stores daily consolidated data files. A scheduled Lambda function runs daily to consolidate the previous day's data from Bucket A to Bucket B.

3. **AWS Glue & Athena**: A Glue database catalog is maintained for the consolidated data, allowing Athena to query the data efficiently. The catalog is automatically updated with new partitions as data is consolidated.

4. **Amazon QuickSight**: Can be connected to Athena to create dashboards and visualizations of your GitHub activity metrics.

## Key Features

- **Efficient Storage**: Data is automatically partitioned by date and event type for optimal query performance
- **Daily Consolidation**: Small webhook files are automatically consolidated into larger files daily for better query performance
- **Cost Optimization**: 
  - Raw data is automatically deleted after 7 days
  - Consolidated data transitions to Glacier storage after 90 days
- **Scalable Architecture**: Can handle high volumes of GitHub webhook events
- **Multiple Data Sources**: Supports GitHub webhooks, custom data API, and GitHub API enrichment

# Setup the infrastructure

## Prerequisites

1. AWS Account with appropriate permissions
2. AWS CDK CLI installed
3. Node.js and npm/yarn installed
4. GitHub repository or organization where you want to track activity

## Register secret tokens

### GitHub Webhook Secret

First, generate a secret token for GitHub Webhook. This token should be a long random string.

Then, register the token in AWS Systems Manager Parameter Store:

- Name: `/github/metrics/secret-token`
- Type: `SecureString`
- Data type: `text`
- Value: The secret token you generated

### GitHub Personal Access Token (Optional)

If you want to enrich webhook data with additional GitHub API calls:

- Name: `/github/metrics/github-token`
- Type: `SecureString`
- Data type: `text`
- Value: Your GitHub personal access token

## Clone the repository

```bash
git clone https://github.com/yutaro-sakamoto/github-activity-metrics-aws-2
cd github-activity-metrics-aws-2
```

## Install dependencies

```bash
yarn install
```

## Deploy the infrastructure

```bash
yarn deploy
```

Memorize the following values from the output:
- `WebhookApiUrl`: URL for configuring GitHub Webhooks
- `CustomDataApiEndpoint`: URL for sending custom metrics

## Setup the GitHub Webhook

### For a repository webhook
See [GitHub documentation for repository webhooks](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks#creating-a-repository-webhook)

### For an organization webhook
See [GitHub documentation for organization webhooks](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks#creating-an-organization-webhook)

### Webhook configuration

- **Payload URL**: Use the `WebhookApiUrl` from the deployment output
- **Content type**: `application/json`
- **Secret**: Use the same secret token you stored in Parameter Store
- **Events**: Select the events you want to track (e.g., Push, Pull requests, Issues, Workflow runs)

## Data Structure

### Raw Data (Bucket A)

Data is stored with the following partition structure:
- GitHub webhooks: `event_type={type}/year={yyyy}/month={mm}/day={dd}/hour={hh}/{timestamp}_{delivery_id}.json`
- Custom data: `custom_data/year={yyyy}/month={mm}/day={dd}/hour={hh}/{timestamp}_{unique_id}.json`
- GitHub API results: `github_api_result/year={yyyy}/month={mm}/day={dd}/hour={hh}/{timestamp}_{delivery_id}.json`

### Consolidated Data (Bucket B)

Daily consolidated files are stored as:
- `{prefix}/year={yyyy}/month={mm}/day={dd}/consolidated_{yyyymmdd}.json`

Each file contains newline-delimited JSON records for efficient querying.

## Querying Data with Athena

After the first daily consolidation runs, you can query your data using Amazon Athena:

1. Open the AWS Athena console
2. Select the `github_metrics_db` database
3. Query the `github_metrics` table

Example queries:

```sql
-- Count events by type for the last 7 days
SELECT event_type, COUNT(*) as event_count
FROM github_metrics
WHERE year = '2024' AND month = '01'
GROUP BY event_type
ORDER BY event_count DESC;

-- Find most active repositories
SELECT repository_name, COUNT(*) as activity_count
FROM github_metrics
WHERE repository_name IS NOT NULL
GROUP BY repository_name
ORDER BY activity_count DESC
LIMIT 10;

-- Analyze pull request metrics
SELECT 
    repository_name,
    COUNT(*) as pr_count,
    SUM(pr_additions) as total_additions,
    SUM(pr_deletions) as total_deletions
FROM github_metrics
WHERE event_type = 'pull_request'
GROUP BY repository_name;
```

## Custom Data API

You can send custom metrics to the system using the Custom Data API:

```bash
curl -X POST {CustomDataApiEndpoint} \
  -H "x-api-key: {your-api-key}" \
  -H "Content-Type: application/json" \
  -d '{
    "Dimensions": [
      {"Name": "metric_type", "Value": "deployment"},
      {"Name": "environment", "Value": "production"}
    ],
    "MeasureName": "deployment_duration",
    "MeasureValue": "300",
    "MeasureValueType": "BIGINT"
  }'
```

## Visualizing with QuickSight

1. Open Amazon QuickSight
2. Create a new data source using Athena
3. Select the `github_metrics_db` database and `github_metrics` table
4. Create visualizations based on your GitHub activity data

## Cost Optimization Tips

1. The raw data bucket automatically deletes files after 7 days
2. Consolidated data transitions to Glacier storage after 90 days
3. Use Athena's query result caching to reduce costs
4. Consider creating aggregated tables for frequently accessed metrics

## Cleanup

To remove all resources:

```bash
yarn destroy
```

Note: S3 buckets with retention policies will be retained by default to prevent data loss.