import {
  TimestreamWriteClient,
  WriteRecordsCommand,
} from "@aws-sdk/client-timestream-write";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const timestreamClient = new TimestreamWriteClient();

function isValidJson(jsonData: any): boolean {
  if (!("Dimensions" in jsonData)) {
    return false;
  }
  if (!("MeasureName" in jsonData)) {
    return false;
  }
  if (!("MeasureValueType" in jsonData)) {
    return false;
  }
  return "MeasureValue" in jsonData || "MeasureValues" in jsonData;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.log("Event received:", JSON.stringify(event, null, 2));

  // Parse and log JSON data from request body if present
  if (event.body) {
    try {
      const jsonData = JSON.parse(event.body);
      console.log("Received JSON data:", JSON.stringify(jsonData, null, 2));
      if (!isValidJson(jsonData)) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            message: "Invalid JSON body",
            error: "Missing required fields",
          }),
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        };
      }
      const time = "Time" in jsonData ? jsonData.Time : Date.now().toString();

      const records = [
        "MeasureValue" in jsonData
          ? {
              Dimensions: jsonData.Dimensions,
              MeasureName: jsonData.MeasureName,
              MeasureValueType: jsonData.MeasureValueType,
              MeasureValue: jsonData.MeasureValue,
              Time: time,
            }
          : {
              Dimensions: jsonData.Dimensions,
              MeasureName: jsonData.MeasureName,
              MeasureValueType: jsonData.MeasureValueType,
              MeasureValues: jsonData.MeasureValues,
              Time: time,
            },
      ];

      console.log("Records to be written:", JSON.stringify(records));

      const command = new WriteRecordsCommand({
        DatabaseName: process.env.TIMESTREAM_DATABASE_NAME,
        TableName: process.env.TIMESTREAM_TABLE_NAME,
        Records: records,
      });

      const result = await timestreamClient.send(command);
      console.log("Timestream write result:", result);
      // Return fixed successful response
      return {
        statusCode: 200,
        body: JSON.stringify({
          result: "success",
        }),
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      };
    } catch (error) {
      console.log("Failed to parse JSON from request body:", error);
      console.log("Raw body content:", event.body);
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "Invalid JSON body",
          error: (error as Error).message,
        }),
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      };
    }
  }

  // Fixed response data
  const responseData = {
    status: "success",
    message: "API call successful",
    timestamp: new Date().toISOString(),
    data: {
      items: [
        { id: 1, name: "Item 1", value: 100 },
        { id: 2, name: "Item 2", value: 200 },
        { id: 3, name: "Item 3", value: 300 },
      ],
      metadata: {
        totalCount: 3,
        apiVersion: "1.0.0",
      },
    },
  };

  // Return fixed successful response
  return {
    statusCode: 200,
    body: JSON.stringify(responseData),
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  };
};
