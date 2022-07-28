/**
 *  Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import * as cdk from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { AcceleratorStack, AcceleratorStackProps } from './accelerator-stack';
import { Organization } from '@aws-accelerator/constructs';
import { Logger } from '../logger';

export class KeyStack extends AcceleratorStack {
  public static readonly CROSS_ACCOUNT_ACCESS_ROLE_NAME = 'AWSAccelerator-CrossAccount-SsmParameter-Role';
  public static readonly ACCELERATOR_KEY_ARN_PARAMETER_NAME = '/accelerator/kms/key-arn';

  constructor(scope: Construct, id: string, props: AcceleratorStackProps) {
    super(scope, id, props);

    Logger.debug(`[key-stack] Region: ${cdk.Stack.of(this).region}`);

    const organizationId = props.organizationConfig.enable ? new Organization(this, 'Organization').id : '';

    const key = new cdk.aws_kms.Key(this, 'AcceleratorKey', {
      alias: 'alias/accelerator/kms/key',
      description: 'AWS Accelerator Kms Key',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    if (props.organizationConfig.enable) {
      // Allow Accelerator Role to use the encryption key
      key.addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          sid: `Allow Accelerator Role to use the encryption key`,
          principals: props?.accountsConfig?.accountIds?.map(item => (new cdk.aws_iam.AccountPrincipal(item.accountId))),
          actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: ['*'],
          conditions: {
            ArnLike: {
              'aws:PrincipalARN': [`arn:${cdk.Stack.of(this).partition}:iam::*:role/AWSAccelerator-*`],
            },
          },
        }),
      );
    }

    // Allow Cloudwatch logs to use the encryption key
    key.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: `Allow Cloudwatch logs to use the encryption key`,
        principals: [new cdk.aws_iam.ServicePrincipal(`logs.amazonaws.com.cn`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
      }),
    );

    // Add all services we want to allow usage
    const allowedServicePrincipals: { name: string; principal: string }[] = [
      { name: 'Sns', principal: 'sns.amazonaws.com' },
      { name: 'Lambda', principal: 'lambda.amazonaws.com' },
      { name: 'Cloudwatch', principal: 'cloudwatch.amazonaws.com' },
      // Add similar objects for any other service principal needs access to this key
    ];
    if (props.securityConfig.centralSecurityServices.macie.enable) {
      allowedServicePrincipals.push({ name: 'Macie', principal: 'macie.amazonaws.com' });
    }
    if (props.securityConfig.centralSecurityServices.guardduty.enable) {
      allowedServicePrincipals.push({ name: 'Guardduty', principal: 'guardduty.amazonaws.com' });
    }

    allowedServicePrincipals!.forEach(item => {
      key.addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          sid: `Allow ${item.name} service to use the encryption key`,
          principals: [new cdk.aws_iam.ServicePrincipal(item.principal)],
          actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: ['*'],
        }),
      );
    });

    new cdk.aws_ssm.StringParameter(this, 'AcceleratorKmsArnParameter', {
      parameterName: '/accelerator/kms/key-arn',
      stringValue: key.keyArn,
    });

    // IAM Role to get access to accelerator organization level SSM parameters
    // Only create this role in the home region stack
    const accountPrincipals: cdk.aws_iam.PrincipalBase[] = []

    for (const assumedByItem of props?.accountsConfig?.accountIds ?? []) {
        accountPrincipals.push(new cdk.aws_iam.AccountPrincipal(assumedByItem.accountId));
    }

    if (cdk.Stack.of(this).region === props.globalConfig.homeRegion && props.organizationConfig.enable) {
      new cdk.aws_iam.Role(this, 'CrossAccountAcceleratorSsmParamAccessRole', {
        roleName: KeyStack.CROSS_ACCOUNT_ACCESS_ROLE_NAME,
        assumedBy: (props.partition == "aws-cn" && props?.accountsConfig?.accountIds != undefined) ? new cdk.aws_iam.CompositePrincipal(...accountPrincipals) : new cdk.aws_iam.OrganizationPrincipal(organizationId),
        inlinePolicies: {
          default: new cdk.aws_iam.PolicyDocument({
            statements: [
              new cdk.aws_iam.PolicyStatement({
                effect: cdk.aws_iam.Effect.ALLOW,
                actions: ['ssm:GetParameters', 'ssm:GetParameter'],
                resources: [
                  `arn:${cdk.Stack.of(this).partition}:ssm:*:${
                    cdk.Stack.of(this).account
                  }:parameter/accelerator/kms/key-arn`,
                ],
                conditions: {
                  ArnLike: {
                    'aws:PrincipalARN': [`arn:${cdk.Stack.of(this).partition}:iam::*:role/AWSAccelerator-*`],
                  },
                },
              }),
              new cdk.aws_iam.PolicyStatement({
                effect: cdk.aws_iam.Effect.ALLOW,
                actions: ['ssm:DescribeParameters'],
                resources: ['*'],
                conditions: {
                  ArnLike: {
                    'aws:PrincipalARN': [`arn:${cdk.Stack.of(this).partition}:iam::*:role/AWSAccelerator-*`],
                  },
                },
              }),
            ],
          }),
        },
      });

      // AwsSolutions-IAM5: The IAM entity contains wildcard permissions and does not have a cdk_nag
      // rule suppression with evidence for this permission.
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        `${this.stackName}/CrossAccountAcceleratorSsmParamAccessRole/Resource`,
        [
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'This policy is required to give access to ssm parameters in every region where accelerator deployed. Various accelerator roles need permission to describe SSM parameters.',
          },
        ],
      );
    }
  }
}
