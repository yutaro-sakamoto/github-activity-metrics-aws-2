This project constructs the instructure which collects GitHub Webhook data, stores it and visualizes it.

![GitHub webhook visualize architecture](asset/github_webhook_visualize_architecture.drawio.png)

# Examples

Run the following command to send a sample event using Custom Data API.

```
curl -X POST \
--header "x-api-key:<<<<API Key>>>>" \
--header "Content-Type: application/json" \
--data '{
  "Dimensions": [
    {"Name": "repository", "Value": "@example-repo"},
    {"Name": "action", "Value": "push"}
  ],
  "MeasureName": "event_count",
  "MeasureValueType": "BIGINT",
  "MeasureValue": "2"
}' \
<<<<URL of Custom Data API>>>>
```
