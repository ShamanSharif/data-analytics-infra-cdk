import * as cdk from "aws-cdk-lib";
import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as rds from "aws-cdk-lib/aws-rds";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as glue from "aws-cdk-lib/aws-glue";
import * as athena from "aws-cdk-lib/aws-athena";
import * as quicksight from "aws-cdk-lib/aws-quicksight";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as dms from "aws-cdk-lib/aws-dms";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as redshift from "@aws-cdk/aws-redshift-alpha";

export class DataAnalyticsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Define VPC for RDS and Redshift
    const vpc = new ec2.Vpc(this, "AnalyticsVpc", {
      maxAzs: 2, // Number of Availability Zones
      natGateways: 1, // Optional NAT gateway
    });

    // 1. Data Ingestion - AWS DMS setup
    const dmsRole = new iam.Role(this, "DMSRole", {
      assumedBy: new iam.ServicePrincipal("dms.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonDMSVPCManagementRole"
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonDMSRedshiftS3Role"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonS3FullAccess"),
      ],
    });

    // 2. Data Storage - S3 Bucket for raw data
    const dataLakeBucket = new s3.Bucket(this, "DataLakeBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // RDS instance for transactional data
    const rdsInstance = new rds.DatabaseInstance(this, "RDSInstance", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_13_4,
      }),
      vpc,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      multiAz: false,
      allocatedStorage: 100,
      maxAllocatedStorage: 200,
      credentials: rds.Credentials.fromGeneratedSecret("admin"), // auto-generates admin credentials
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      publiclyAccessible: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Redshift Cluster for data warehouse using aws-redshift-alpha
    const redshiftCluster = new redshift.Cluster(this, "RedshiftCluster", {
      masterUser: {
        masterUsername: "admin",
      },
      vpc,
      nodeType: redshift.NodeType.DC2_LARGE,
      numberOfNodes: 2,
      defaultDatabaseName: "analyticsdb",
      publiclyAccessible: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 3. Data Processing and Transformation - Glue and Lambda
    // Glue Database
    const glueDatabase = new glue.CfnDatabase(this, "GlueDatabase", {
      catalogId: this.account,
      databaseInput: {
        name: "analytics_database",
      },
    });

    // Glue Crawler (to catalog data in S3)
    const glueCrawler = new glue.CfnCrawler(this, "GlueCrawler", {
      role: dmsRole.roleArn,
      databaseName: glueDatabase.ref,
      targets: {
        s3Targets: [
          {
            path: `s3://${dataLakeBucket.bucketName}`,
          },
        ],
      },
    });

    // Lambda function for transformation tasks
    const transformFunction = new lambda.Function(this, "TransformFunction", {
      runtime: lambda.Runtime.NODEJS_18_X,
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          console.log("Data transformation in progress");
          return event;
        };
      `),
      handler: "index.handler",
    });

    // 4. Query and Analyze - Athena
    const athenaWorkgroup = new athena.CfnWorkGroup(this, "AthenaWorkgroup", {
      name: "AthenaWorkgroup",
      state: "ENABLED",
      workGroupConfiguration: {
        resultConfiguration: {
          outputLocation: `s3://${dataLakeBucket.bucketName}/athena-results/`,
        },
      },
    });

    // 5. Visualize Data - QuickSight
    const quickSightDashboard = new quicksight.CfnDashboard(
      this,
      "QuickSightDashboard",
      {
        awsAccountId: this.account,
        dashboardId: "analytics_dashboard",
        name: "Analytics Dashboard",
        sourceEntity: {
          sourceTemplate: {
            arn: `arn:aws:quicksight:${this.region}:${this.account}:template/YourTemplateId`, // Replace with your template ARN
            dataSetReferences: [
              {
                dataSetArn: "arn:aws:quicksight:::dataset/YourDataSetId", // Replace with your dataset ARN
                dataSetPlaceholder: "dataset_placeholder",
              },
            ],
          },
        },
      }
    );

    // 6. Monitor and Secure - CloudWatch and CloudTrail
    // CloudWatch Alarms
    const cloudWatchAlarm = new cloudwatch.Alarm(this, "RedshiftCPUAlarm", {
      metric: new cloudwatch.Metric({
        namespace: "AWS/Redshift",
        metricName: "CPUUtilization",
        dimensionsMap: {
          ClusterIdentifier: redshiftCluster.clusterName,
        },
      }),
      threshold: 80,
      evaluationPeriods: 3,
    });

    // CloudTrail for auditing API calls
    const trail = new cloudtrail.Trail(this, "CloudTrail", {
      bucket: dataLakeBucket,
    });

    // Output S3 bucket URL for debugging
    new cdk.CfnOutput(this, "S3BucketURL", {
      value: dataLakeBucket.bucketWebsiteUrl,
      description: "The S3 bucket URL where data is stored",
    });
  }
}
