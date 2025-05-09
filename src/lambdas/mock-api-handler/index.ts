import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

/**
 * Lambda handler that always returns a successful response with fixed data
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.log("Event received:", JSON.stringify(event, null, 2));

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
