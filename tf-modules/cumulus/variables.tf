# Required

variable "cmr_client_id" {
  type = string
}

variable "cmr_environment" {
  type = string
}

variable "cmr_password" {
  type = string
}

variable "cmr_provider" {
  type = string
}

variable "cmr_username" {
  type = string
}

variable "dynamo_tables" {
  type = map(string)
}

variable "ecs_cluster_desired_size" {
  type = number
}

variable "ecs_cluster_instance_subnet_ids" {
  type = list(string)
}

variable "ecs_cluster_max_size" {
  type = number
}

variable "ecs_cluster_min_size" {
  type = number
}

variable "elasticsearch_arn" {
  type = string
}

variable "lambda_subnet_ids" {
  type = list(string)
}

variable "prefix" {
  type = string
}

variable "system_bucket" {
  type = string
}

variable "urs_client_id" {
  type        = string
  description = "The URS app ID"
}

variable "urs_client_password" {
  type        = string
  description = "The URS app password"
}

variable "vpc_id" {
  type = string
}

# Optional

variable "ecs_container_stop_timeout" {
  type    = string
  default = "2m"
}

variable "ecs_cluster_instance_docker_volume_size" {
  type        = number
  description = "Size (in GB) of the volume that Docker uses for image and metadata storage"
  default     = 50
}

variable "ecs_cluster_instance_image_id" {
  type        = string
  description = "AMI ID of ECS instances"
  default     = "ami-03e7dd4efa9b91eda"
}

variable "ecs_cluster_instance_type" {
  type        = "string"
  description = "EC2 instance type for cluster instances"
  default     = "t2.medium"
}

variable "ecs_cluster_scale_in_adjustment_percent" {
  type    = number
  default = -5
}

variable "ecs_cluster_scale_in_threshold_percent" {
  type    = number
  default = 25
}

variable "ecs_cluster_scale_out_adjustment_percent" {
  type    = number
  default = 10
}

variable "ecs_cluster_scale_out_threshold_percent" {
  type    = number
  default = 75
}

variable "ecs_docker_hub_config" {
  type    = object({ username = string, password = string, email = string })
  default = null
}

variable "ecs_docker_storage_driver" {
  type    = string
  default = "overlay2"
}

variable "ecs_efs_config" {
  type    = object({ mount_target_id = string, mount_point = string })
  default = null
}

variable "key_name" {
  type    = string
  default = null
}

variable "permissions_boundary_arn" {
  type    = string
  default = null
}

variable "private_buckets" {
  type    = list(string)
  default = []
}

variable "protected_buckets" {
  type    = list(string)
  default = []
}

variable "public_buckets" {
  type    = list(string)
  default = []
}

variable "urs_url" {
  type        = string
  default     = "https://urs.earthdata.nasa.gov/"
  description = "The URL of the Earthdata Login site"
}