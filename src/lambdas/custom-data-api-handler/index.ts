import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const s3Client = new S3Client();

function isValidJson(jsonData: any): boolean {
  if (!('Dimensions' in jsonData)) {
    return false;
  }
  if (!('MeasureName' in jsonData)) {
    return false;
  }
  if (!('MeasureValueType' in jsonData)) {
    return false;
  }
  return 'MeasureValue' in jsonData || 'MeasureValues' in jsonData;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.log('Event received:', JSON.stringify(event, null, 2));

  // Parse and log JSON data from request body if present
  if (event.body) {
    try {
      const jsonData = JSON.parse(event.body);
      console.log('Received JSON data:', JSON.stringify(jsonData, null, 2));
      if (!isValidJson(jsonData)) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            message: 'Invalid JSON body',
            error: 'Missing required fields',
          }),
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        };
      }

      // Get current timestamp
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = String(now.getUTCMonth() + 1).padStart(2, '0');
      const day = String(now.getUTCDate()).padStart(2, '0');
      const hour = String(now.getUTCHours()).padStart(2, '0');
      const timestamp = now.toISOString();
      const time = 'Time' in jsonData ? jsonData.Time : timestamp;

      // Create structured record for S3
      const structuredRecord = {
        timestamp: time,
        dimensions: jsonData.Dimensions,
        measure_name: jsonData.MeasureName,
        measure_value_type: jsonData.MeasureValueType,
      };

      // Add measure value(s)
      if ('MeasureValue' in jsonData) {
        structuredRecord[jsonData.MeasureName] = jsonData.MeasureValue;
      } else if ('MeasureValues' in jsonData) {
        jsonData.MeasureValues.forEach((mv: any) => {
          structuredRecord[mv.Name] = mv.Value;
        });
      }

      // Create S3 key with partitioning
      // Format: custom_data/year=<yyyy>/month=<mm>/day=<dd>/hour=<hh>/<timestamp>_<unique_id>.json
      const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const key = `custom_data/year=${year}/month=${month}/day=${day}/hour=${hour}/${timestamp}_${uniqueId}.json`;

      console.log('S3 record to be written:', JSON.stringify(structuredRecord));

      const command = new PutObjectCommand({
        Bucket: process.env.RAW_DATA_BUCKET!,
        Key: key,
        Body: JSON.stringify(structuredRecord),
        ContentType: 'application/json',
      });

      const result = await s3Client.send(command);
      console.log('S3 write result:', result);
      console.log(`Successfully wrote to S3: ${key}`);

      // Return fixed successful response
      return {
        statusCode: 200,
        body: JSON.stringify({
          result: 'success',
        }),
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      };
    } catch (error) {
      console.log('Failed to process request:', error);
      console.log('Raw body content:', event.body);
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: 'Invalid request',
          error: (error as Error).message,
        }),
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      };
    }
  }

  return {
    statusCode: 400,
    body: JSON.stringify({
      message: 'No request body provided',
    }),
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  };
};