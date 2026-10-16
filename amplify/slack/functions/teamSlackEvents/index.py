import json


# Placeholder handler, implemented in a later step
def handler(event, context):
    return {
        "statusCode": 501,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({"message": "Not implemented"}),
    }
