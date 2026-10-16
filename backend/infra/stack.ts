import { existsSync } from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";

export interface FestivalPlaylistStackProps extends cdk.StackProps {
  stage: string;
  prefix: string;
  alarmEmail: string;
  bedrockProvider: "nova" | "claude";
  bedrockModelId: string;
  bedrockApi: "mantle" | "invoke";
}

const LOCAL_ORIGIN = "http://127.0.0.1:3000";
const METRICS_NAMESPACE = "FestivalPlaylist";
const WEB_OUT = path.join(__dirname, "..", "..", "out");

export class FestivalPlaylistStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FestivalPlaylistStackProps) {
    super(scope, id, props);
    const { prefix, stage } = props;
    const name = (suffix: string) => `${prefix}-${suffix}`;
    // dev: everything is disposable with `cdk destroy`.
    const removalPolicy = stage === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    const autoDelete = removalPolicy === cdk.RemovalPolicy.DESTROY;

    // ---------------- Storage ----------------

    const table = new dynamodb.TableV2(this, "Data", {
      tableName: name("data"),
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    const webBucket = new s3.Bucket(this, "WebBucket", {
      bucketName: `${name("web")}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: autoDelete,
    });

    // ---------------- Front-end: CloudFront ----------------

    // Next.js static export writes /path/index.html; map /path and /path/ to it.
    const rewrite = new cloudfront.Function(this, "IndexRewrite", {
      functionName: name("index-rewrite"),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith('/')) request.uri = uri + 'index.html';
  else if (uri.split('/').pop().indexOf('.') === -1) request.uri = uri + '/index.html';
  return request;
}`),
    });

    const distribution = new cloudfront.Distribution(this, "Cdn", {
      comment: name("web"),
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [{ function: rewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 404, responsePagePath: "/404.html", ttl: cdk.Duration.minutes(1) },
        { httpStatus: 404, responseHttpStatus: 404, responsePagePath: "/404.html", ttl: cdk.Duration.minutes(1) },
      ],
    });
    const siteUrl = `https://${distribution.distributionDomainName}`;
    const allowedOrigins = [siteUrl, LOCAL_ORIGIN];

    const uploadBucket = new s3.Bucket(this, "UploadBucket", {
      bucketName: `${name("uploads")}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Posters are deleted after processing; this catches anything left behind.
      lifecycleRules: [{ id: "expire-uploads", expiration: cdk.Duration.days(1), abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) }],
      cors: [{ allowedMethods: [s3.HttpMethods.POST], allowedOrigins, allowedHeaders: ["*"], maxAge: 3600 }],
      removalPolicy,
      autoDeleteObjects: autoDelete,
    });

    // ---------------- Secrets ----------------

    // clientId/clientSecret are placeholders: fill them in after the first deploy
    // (see README). tokenKey is generated here and encrypts Spotify tokens at rest.
    const spotifySecret = new secrets.Secret(this, "SpotifySecret", {
      secretName: `festival-playlist/${stage}/spotify`,
      description: "Spotify app credentials (clientId, clientSecret) and the token encryption key",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ clientId: "PREENCHER_CLIENT_ID", clientSecret: "PREENCHER_CLIENT_SECRET" }),
        generateStringKey: "tokenKey",
        passwordLength: 48,
        excludePunctuation: true,
      },
      removalPolicy,
    });

    // ---------------- Auth: Cognito ----------------

    const userPool = new cognito.UserPool(this, "Users", {
      userPoolName: name("users"),
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: { minLength: 8, requireLowercase: false, requireDigits: false, requireUppercase: false, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      userVerification: {
        emailSubject: "Seu código — Line-up → Playlist",
        emailBody: "Seu código de verificação é {####}",
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      removalPolicy,
    });

    const webClient = userPool.addClient("WebClient", {
      userPoolClientName: name("web"),
      generateSecret: false,
      preventUserExistenceErrors: true,
      // The site has its own login form and calls the user pool API directly.
      authFlows: { userPassword: true },
      disableOAuth: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // ---------------- Lambdas ----------------

    const fn = (id: string, suffix: string, entry: string, opts: { memory: number; timeout: cdk.Duration; env?: Record<string, string> }) => {
      const functionName = name(suffix);
      const logGroup = new logs.LogGroup(this, `${id}Logs`, {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy,
      });
      return new NodejsFunction(this, id, {
        functionName,
        entry: path.join(__dirname, "..", "src", "handlers", entry),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: opts.memory,
        timeout: opts.timeout,
        logGroup,
        loggingFormat: lambda.LoggingFormat.JSON,
        retryAttempts: 0,
        environment: {
          STAGE: stage,
          TABLE_NAME: table.tableName,
          SPOTIFY_SECRET_ARN: spotifySecret.secretArn,
          NODE_OPTIONS: "--enable-source-maps",
          ...opts.env,
        },
        bundling: { minify: true, sourceMap: true, target: "node22" },
      });
    };

    const playlistWorker = fn("PlaylistWorker", "playlist-worker", "playlist-worker.ts", {
      memory: 512,
      timeout: cdk.Duration.minutes(10),
    });

    const lineupProcessor = fn("LineupProcessor", "lineup-processor", "lineup-processor.ts", {
      memory: 1024,
      timeout: cdk.Duration.minutes(5),
      env: { BEDROCK_PROVIDER: props.bedrockProvider, BEDROCK_MODEL_ID: props.bedrockModelId, BEDROCK_API: props.bedrockApi },
    });

    const api = fn("Api", "api", "api.ts", {
      memory: 512,
      timeout: cdk.Duration.seconds(29),
      env: {
        UPLOAD_BUCKET: uploadBucket.bucketName,
        PLAYLIST_WORKER_ARN: playlistWorker.functionArn,
        ALLOWED_ORIGINS: allowedOrigins.join(","),
      },
    });

    for (const f of [api, lineupProcessor, playlistWorker]) {
      table.grantReadWriteData(f);
      spotifySecret.grantRead(f);
    }
    uploadBucket.grantPut(api, "uploads/*");
    uploadBucket.grantRead(lineupProcessor, "uploads/*");
    uploadBucket.grantDelete(lineupProcessor, "uploads/*");
    playlistWorker.grantInvoke(api);

    lineupProcessor.addToRolePolicy(new iam.PolicyStatement({ actions: ["textract:DetectDocumentText"], resources: ["*"] }));
    // Cross-region inference profiles (us./global.) route to the foundation model in
    // other regions, so the model ARN uses a region wildcard.
    const vendor = props.bedrockProvider === "nova" ? "amazon" : "anthropic";
    lineupProcessor.addToRolePolicy(
      props.bedrockProvider === "claude" && props.bedrockApi === "mantle"
        ? new iam.PolicyStatement({
            actions: ["bedrock-mantle:CreateInference"],
            resources: [`arn:${this.partition}:bedrock-mantle:${this.region}:${this.account}:project/*`],
          })
        : new iam.PolicyStatement({
            actions: ["bedrock:InvokeModel"],
            resources: [
              `arn:${this.partition}:bedrock:*::foundation-model/${vendor}.*`,
              `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/*${vendor}.*`,
            ],
          }),
    );

    uploadBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(lineupProcessor), {
      prefix: "uploads/",
      suffix: ".jpg",
    });

    // ---------------- API Gateway (HTTP API) ----------------

    const accessLogs = new logs.LogGroup(this, "ApiAccessLogs", {
      logGroupName: `/aws/apigateway/${name("api")}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy,
    });

    const httpApi = new apigw.HttpApi(this, "HttpApi", {
      apiName: name("api"),
      description: "Festival Playlist Generator API",
      corsPreflight: {
        allowOrigins: allowedOrigins,
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.PUT, apigw.CorsHttpMethod.DELETE],
        allowHeaders: ["authorization", "content-type"],
        maxAge: cdk.Duration.hours(1),
      },
      defaultAuthorizer: new HttpJwtAuthorizer("CognitoJwt", `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`, {
        authorizerName: name("cognito-jwt"),
        jwtAudience: [webClient.userPoolClientId],
      }),
    });

    const stageResource = httpApi.defaultStage!.node.defaultChild as apigw.CfnStage;
    stageResource.defaultRouteSettings = { throttlingBurstLimit: 50, throttlingRateLimit: 20 };
    stageResource.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: "$context.requestId",
        routeKey: "$context.routeKey",
        status: "$context.status",
        latency: "$context.integrationLatency",
        ip: "$context.identity.sourceIp",
        sub: "$context.authorizer.claims.sub",
        error: "$context.integrationErrorMessage",
      }),
    };

    const integration = new HttpLambdaIntegration("ApiIntegration", api);
    const route = (method: apigw.HttpMethod, routePath: string, isPublic = false) =>
      httpApi.addRoutes({ path: routePath, methods: [method], integration, ...(isPublic ? { authorizer: new apigw.HttpNoneAuthorizer() } : {}) });

    route(apigw.HttpMethod.GET, "/health", true);
    route(apigw.HttpMethod.GET, "/spotify/callback", true);
    route(apigw.HttpMethod.POST, "/lineups");
    route(apigw.HttpMethod.GET, "/lineups");
    route(apigw.HttpMethod.GET, "/lineups/{id}");
    route(apigw.HttpMethod.PUT, "/lineups/{id}");
    route(apigw.HttpMethod.DELETE, "/lineups/{id}");
    route(apigw.HttpMethod.GET, "/spotify/status");
    route(apigw.HttpMethod.POST, "/spotify/authorize");
    route(apigw.HttpMethod.DELETE, "/spotify/connection");
    route(apigw.HttpMethod.POST, "/playlists");
    route(apigw.HttpMethod.GET, "/playlists");
    route(apigw.HttpMethod.GET, "/playlists/{id}");
    route(apigw.HttpMethod.DELETE, "/playlists/{id}");

    const apiUrl = httpApi.apiEndpoint;

    // ---------------- Front-end deployment ----------------

    if (existsSync(WEB_OUT)) {
      const site = new s3deploy.BucketDeployment(this, "DeploySite", {
        sources: [s3deploy.Source.asset(WEB_OUT)],
        destinationBucket: webBucket,
        exclude: ["config.json"],
        distribution,
        distributionPaths: ["/*"],
        memoryLimit: 512,
      });
      const config = new s3deploy.BucketDeployment(this, "DeployConfig", {
        sources: [
          s3deploy.Source.jsonData("config.json", {
            region: this.region,
            apiUrl,
            userPoolId: userPool.userPoolId,
            userPoolClientId: webClient.userPoolClientId,
          }),
        ],
        destinationBucket: webBucket,
        prune: false,
        cacheControl: [s3deploy.CacheControl.noCache()],
        distribution,
        distributionPaths: ["/config.json"],
      });
      config.node.addDependency(site);
    } else {
      cdk.Annotations.of(this).addWarning(`Front-end build not found at ${WEB_OUT}; run "npm run build" in the repo root before deploying.`);
    }

    // ---------------- Observability: CloudWatch ----------------

    const alarmTopic = new sns.Topic(this, "Alarms", { topicName: name("alarms"), displayName: "Festival Playlist alarms" });
    if (props.alarmEmail) alarmTopic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    const notify = new cwActions.SnsAction(alarmTopic);

    const custom = (metricName: string, statistic = "Sum") =>
      new cw.Metric({ namespace: METRICS_NAMESPACE, metricName, dimensionsMap: { Stage: stage }, statistic, period: cdk.Duration.minutes(5) });

    const alarm = (id: string, alarmName: string, metric: cw.IMetric, threshold: number, description: string) =>
      new cw.Alarm(this, id, {
        alarmName: name(alarmName),
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(notify);

    const functions = [
      ["Api", "api", api],
      ["LineupProcessor", "lineup-processor", lineupProcessor],
      ["PlaylistWorker", "playlist-worker", playlistWorker],
    ] as const;
    for (const [id, suffix, f] of functions) {
      alarm(`${id}ErrorsAlarm`, `${suffix}-errors`, f.metricErrors({ period: cdk.Duration.minutes(5) }), 1, `Lambda ${suffix} threw errors`);
    }
    alarm("Api5xxAlarm", "api-5xx", httpApi.metricServerError({ period: cdk.Duration.minutes(5) }), 5, "HTTP API returned 5xx responses");
    alarm("LineupFailuresAlarm", "lineup-failures", custom("LineupFailures"), 3, "Posters failing to process (Textract/Bedrock)");
    alarm("PlaylistFailuresAlarm", "playlist-failures", custom("PlaylistFailures"), 3, "Playlist generation failing (Spotify)");

    const dashboard = new cw.Dashboard(this, "Dashboard", { dashboardName: name("overview") });
    dashboard.addWidgets(
      new cw.GraphWidget({
        title: "API — requisições e erros",
        left: [httpApi.metricCount({ period: cdk.Duration.minutes(5) })],
        right: [httpApi.metricClientError({ period: cdk.Duration.minutes(5) }), httpApi.metricServerError({ period: cdk.Duration.minutes(5) })],
        width: 12,
      }),
      new cw.GraphWidget({
        title: "API — latência p95 (ms)",
        left: [httpApi.metricLatency({ period: cdk.Duration.minutes(5), statistic: "p95" })],
        width: 12,
      }),
      new cw.GraphWidget({
        title: "Lambdas — erros",
        left: [api, lineupProcessor, playlistWorker].map((f) => f.metricErrors({ period: cdk.Duration.minutes(5) })),
        width: 12,
      }),
      new cw.GraphWidget({
        title: "Lambdas — duração p95 (ms)",
        left: [api, lineupProcessor, playlistWorker].map((f) => f.metricDuration({ period: cdk.Duration.minutes(5), statistic: "p95" })),
        width: 12,
      }),
      new cw.GraphWidget({
        title: "Produto — cartazes e playlists",
        left: [custom("LineupsProcessed"), custom("PlaylistsCreated"), custom("SpotifyConnections")],
        right: [custom("LineupFailures"), custom("PlaylistFailures")],
        width: 12,
      }),
      new cw.GraphWidget({
        title: "Produto — volume",
        left: [custom("ArtistsExtracted"), custom("TracksAdded")],
        right: [custom("LineupProcessingTime", "p95"), custom("PlaylistGenerationTime", "p95")],
        width: 12,
      }),
    );

    // ---------------- Outputs ----------------

    const out = (id: string, value: string, description: string) => new cdk.CfnOutput(this, id, { value, description });
    out("SiteUrl", siteUrl, "Front-end (CloudFront)");
    out("ApiUrl", apiUrl, "HTTP API endpoint");
    out("SpotifyRedirectUri", `${apiUrl}/spotify/callback`, "Add this Redirect URI to your Spotify app");
    out("SpotifySecretName", spotifySecret.secretName, "Secrets Manager secret holding the Spotify credentials");
    out("UserPoolId", userPool.userPoolId, "Cognito user pool");
    out("UserPoolClientId", webClient.userPoolClientId, "Cognito app client (web)");
    out("TableName", table.tableName, "DynamoDB table");
    out("DashboardUrl", `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards/dashboard/${name("overview")}`, "CloudWatch dashboard");
  }
}
